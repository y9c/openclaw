import {
  abortEmbeddedPiRun,
  getActiveEmbeddedRunCount,
  waitForActiveEmbeddedRuns,
} from "../../agents/pi-embedded-runner/runs.js";
import {
  loadConfig,
  persistEffectiveConfigLastKnownGood,
  readConfigFileSnapshot,
  readEffectiveConfigLastKnownGood,
  resolveConfigPath,
  resolveConfigSnapshotHash,
  restoreEffectiveConfigLastKnownGood,
} from "../../config/config.js";
import type { startGatewayServer } from "../../gateway/server.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import { restartGatewayProcessWithFreshPid } from "../../infra/process-respawn.js";
import { writeRestartSentinel } from "../../infra/restart-sentinel.js";
import {
  consumeGatewaySigusr1RestartAuthorization,
  isGatewaySigusr1RestartExternallyAllowed,
  markGatewaySigusr1RestartHandled,
  scheduleGatewaySigusr1Restart,
} from "../../infra/restart.js";
import { detectRespawnSupervisor } from "../../infra/supervisor-markers.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getActiveTaskCount,
  markGatewayDraining,
  resetAllLanes,
  waitForActiveTasks,
} from "../../process/command-queue.js";
import { createRestartIterationHook } from "../../process/restart-recovery.js";
import type { RuntimeEnv } from "../../runtime.js";

const gatewayLog = createSubsystemLogger("gateway");
const LAUNCHD_SUPERVISED_RESTART_EXIT_DELAY_MS = 1500;
const DEFAULT_RESTART_DRAIN_TIMEOUT_MS = 300_000;
const CONFIG_RECOVERY_READINESS_TIMEOUT_MS = 15_000;
const CONFIG_RECOVERY_READINESS_POLL_MS = 250;
const STARTUP_SHUTDOWN_GRACE_MS = 100;
const CONFIG_AUTO_RECOVERY_MESSAGE =
  "Gateway recovered automatically after a failed config change and restored the last known good configuration.";

type GatewayRunSignalAction = "stop" | "restart";
type GatewayReadinessWaitResult =
  | { status: "ready"; failing: string[] }
  | { status: "timeout"; failing: string[] }
  | { status: "aborted"; signalAction: GatewayRunSignalAction | null };

async function waitFor(ms: number) {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export async function runGatewayLoop(params: {
  start: (params?: {
    startupStartedAt?: number;
  }) => Promise<Awaited<ReturnType<typeof startGatewayServer>>>;
  runtime: RuntimeEnv;
  lockPort?: number;
}) {
  let startupStartedAt = Date.now();
  let lock = await acquireGatewayLock({ port: params.lockPort });
  let server: Awaited<ReturnType<typeof startGatewayServer>> | null = null;
  let startingServerPromise: Promise<Awaited<ReturnType<typeof startGatewayServer>>> | null = null;
  let shuttingDown = false;
  let pendingSignalAction: GatewayRunSignalAction | null = null;
  let restartResolver: (() => void) | null = null;

  const cleanupSignals = () => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGUSR1", onSigusr1);
  };
  const exitProcess = (code: number) => {
    cleanupSignals();
    params.runtime.exit(code);
  };
  const releaseLockIfHeld = async (): Promise<boolean> => {
    if (!lock) {
      return false;
    }
    await lock.release();
    lock = null;
    return true;
  };
  const reacquireLockForInProcessRestart = async (): Promise<boolean> => {
    try {
      startupStartedAt = Date.now();
      lock = await acquireGatewayLock({ port: params.lockPort });
      return true;
    } catch (err) {
      gatewayLog.error(`failed to reacquire gateway lock for in-process restart: ${String(err)}`);
      exitProcess(1);
      return false;
    }
  };
  const handleRestartAfterServerClose = async () => {
    const hadLock = await releaseLockIfHeld();
    // Release the lock BEFORE spawning so the child can acquire it immediately.
    const respawn = restartGatewayProcessWithFreshPid();
    if (respawn.mode === "spawned" || respawn.mode === "supervised") {
      const modeLabel =
        respawn.mode === "spawned"
          ? `spawned pid ${respawn.pid ?? "unknown"}`
          : "supervisor restart";
      gatewayLog.info(`restart mode: full process restart (${modeLabel})`);
      if (
        respawn.mode === "supervised" &&
        detectRespawnSupervisor(process.env, process.platform) === "launchd"
      ) {
        // A short clean-exit pause keeps rapid SIGUSR1/config restarts from
        // tripping launchd crash-loop throttling before KeepAlive relaunches.
        await new Promise((resolve) => {
          setTimeout(resolve, LAUNCHD_SUPERVISED_RESTART_EXIT_DELAY_MS);
        });
      }
      exitProcess(0);
      return;
    }
    if (respawn.mode === "failed") {
      gatewayLog.warn(
        `full process restart failed (${respawn.detail ?? "unknown error"}); falling back to in-process restart`,
      );
    } else {
      gatewayLog.info(
        `restart mode: in-process restart (${respawn.detail ?? "OPENCLAW_NO_RESPAWN"})`,
      );
    }
    if (hadLock && !(await reacquireLockForInProcessRestart())) {
      return;
    }
    restartResolver?.();
  };
  const handleStopAfterServerClose = async () => {
    await releaseLockIfHeld();
    exitProcess(0);
  };
  const readCurrentConfigSnapshotBestEffort = async () => {
    return await readConfigFileSnapshot().catch(() => null);
  };
  const resolveEffectiveConfigPath = (configPath?: string | null) =>
    configPath && configPath.trim().length > 0 ? configPath : resolveConfigPath();
  const readLastKnownGoodBestEffort = async (configPath?: string | null) => {
    return await readEffectiveConfigLastKnownGood(resolveEffectiveConfigPath(configPath)).catch(
      () => null,
    );
  };
  const writeAutoRecoverySentinel = async (reason: string) => {
    await writeRestartSentinel({
      kind: "config-auto-recovery",
      status: "ok",
      ts: Date.now(),
      message: CONFIG_AUTO_RECOVERY_MESSAGE,
      stats: {
        mode: "config-auto-recovery",
        reason,
        after: { restoredFrom: "last-known-good" },
      },
    }).catch((err) => {
      gatewayLog.warn(`failed to write config auto-recovery sentinel: ${String(err)}`);
    });
  };
  const recoverConfigAndContinue = async (params: {
    configPath?: string | null;
    reason: string;
  }): Promise<boolean> => {
    const configPath = resolveEffectiveConfigPath(params.configPath);
    const restored = await restoreEffectiveConfigLastKnownGood(configPath).catch((err) => {
      gatewayLog.error(`failed to restore last-known-good config: ${String(err)}`);
      return null;
    });
    if (!restored) {
      return false;
    }
    gatewayLog.warn(
      `restored last-known-good config after ${params.reason}; retrying gateway startup`,
    );
    if (!(await releaseLockIfHeld())) {
      return false;
    }
    if (!(await reacquireLockForInProcessRestart())) {
      return false;
    }
    await writeAutoRecoverySentinel(params.reason);
    shuttingDown = false;
    return true;
  };
  const shouldAutoRecoverFromInvalidConfig = (params: {
    snapshot: Awaited<ReturnType<typeof readCurrentConfigSnapshotBestEffort>>;
    currentHash: string | null;
    lastKnownGoodHash: string | null;
  }) => {
    return (
      params.snapshot?.valid === false &&
      params.currentHash !== null &&
      params.lastKnownGoodHash !== null &&
      params.currentHash !== params.lastKnownGoodHash
    );
  };
  const waitForServerReadiness = async (
    activeServer: Awaited<ReturnType<typeof startGatewayServer>>,
  ): Promise<GatewayReadinessWaitResult> => {
    const getReadiness = activeServer.getReadiness;
    if (typeof getReadiness !== "function") {
      return { status: "ready", failing: [] };
    }
    const deadline = Date.now() + CONFIG_RECOVERY_READINESS_TIMEOUT_MS;
    let failing: string[] = [];
    while (Date.now() < deadline) {
      if (shuttingDown) {
        return { status: "aborted", signalAction: pendingSignalAction };
      }
      const readiness = getReadiness();
      if (readiness.ready) {
        return { status: "ready", failing: [] };
      }
      failing = readiness.failing;
      await waitFor(CONFIG_RECOVERY_READINESS_POLL_MS);
    }
    return { status: "timeout", failing };
  };

  const SUPERVISOR_STOP_TIMEOUT_MS = 30_000;
  const SHUTDOWN_TIMEOUT_MS = SUPERVISOR_STOP_TIMEOUT_MS - 5_000;
  const resolveRestartDrainTimeoutMs = () => {
    try {
      const timeoutMs = loadConfig().gateway?.reload?.deferralTimeoutMs;
      return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs >= 0
        ? timeoutMs
        : DEFAULT_RESTART_DRAIN_TIMEOUT_MS;
    } catch {
      return DEFAULT_RESTART_DRAIN_TIMEOUT_MS;
    }
  };

  const request = (action: GatewayRunSignalAction, signal: string) => {
    if (shuttingDown) {
      gatewayLog.info(`received ${signal} during shutdown; ignoring`);
      return;
    }
    shuttingDown = true;
    pendingSignalAction = action;
    const isRestart = action === "restart";
    const restartDrainTimeoutMs = isRestart ? resolveRestartDrainTimeoutMs() : 0;
    gatewayLog.info(`received ${signal}; ${isRestart ? "restarting" : "shutting down"}`);

    // Allow extra time for draining active turns on restart.
    const forceExitMs = isRestart
      ? restartDrainTimeoutMs + SHUTDOWN_TIMEOUT_MS
      : SHUTDOWN_TIMEOUT_MS;
    const forceExitTimer = setTimeout(() => {
      gatewayLog.error("shutdown timed out; exiting without full cleanup");
      // Keep the in-process watchdog below the supervisor stop budget so this
      // path wins before launchd/systemd escalates to a hard kill. Exit
      // non-zero on any timeout so supervised installs restart cleanly.
      exitProcess(1);
    }, forceExitMs);

    void (async () => {
      try {
        // On restart, wait for in-flight agent turns to finish before
        // tearing down the server so buffered messages are delivered.
        if (isRestart) {
          // Reject new enqueues immediately during the drain window so
          // sessions get an explicit restart error instead of silent task loss.
          markGatewayDraining();
          const activeTasks = getActiveTaskCount();
          const activeRuns = getActiveEmbeddedRunCount();

          // Best-effort abort for compacting runs so long compaction operations
          // don't hold session write locks across restart boundaries.
          if (activeRuns > 0) {
            abortEmbeddedPiRun(undefined, { mode: "compacting" });
          }

          if (activeTasks > 0 || activeRuns > 0) {
            gatewayLog.info(
              `draining ${activeTasks} active task(s) and ${activeRuns} active embedded run(s) before restart (timeout ${restartDrainTimeoutMs}ms)`,
            );
            const [tasksDrain, runsDrain] = await Promise.all([
              activeTasks > 0
                ? waitForActiveTasks(restartDrainTimeoutMs)
                : Promise.resolve({ drained: true }),
              activeRuns > 0
                ? waitForActiveEmbeddedRuns(restartDrainTimeoutMs)
                : Promise.resolve({ drained: true }),
            ]);
            if (tasksDrain.drained && runsDrain.drained) {
              gatewayLog.info("all active work drained");
            } else {
              gatewayLog.warn("drain timeout reached; proceeding with restart");
              // Final best-effort abort to avoid carrying active runs into the
              // next lifecycle when drain time budget is exhausted.
              abortEmbeddedPiRun(undefined, { mode: "all" });
            }
          }
        }

        const activeServer =
          server ??
          (startingServerPromise
            ? await Promise.race([
                startingServerPromise.catch(
                  () => null as Awaited<ReturnType<typeof startGatewayServer>> | null,
                ),
                waitFor(STARTUP_SHUTDOWN_GRACE_MS).then(() => null),
              ])
            : null);
        server = activeServer;
        await activeServer?.close({
          reason: isRestart ? "gateway restarting" : "gateway stopping",
          restartExpectedMs: isRestart ? 1500 : null,
        });
      } catch (err) {
        gatewayLog.error(`shutdown error: ${String(err)}`);
      } finally {
        clearTimeout(forceExitTimer);
        server = null;
        if (isRestart) {
          await handleRestartAfterServerClose();
        } else {
          await handleStopAfterServerClose();
        }
      }
    })();
  };

  const onSigterm = () => {
    gatewayLog.info("signal SIGTERM received");
    request("stop", "SIGTERM");
  };
  const onSigint = () => {
    gatewayLog.info("signal SIGINT received");
    request("stop", "SIGINT");
  };
  const onSigusr1 = () => {
    gatewayLog.info("signal SIGUSR1 received");
    const authorized = consumeGatewaySigusr1RestartAuthorization();
    if (!authorized) {
      if (!isGatewaySigusr1RestartExternallyAllowed()) {
        gatewayLog.warn(
          "SIGUSR1 restart ignored (not authorized; commands.restart=false or use gateway tool).",
        );
        return;
      }
      if (shuttingDown) {
        gatewayLog.info("received SIGUSR1 during shutdown; ignoring");
        return;
      }
      // External SIGUSR1 requests should still reuse the in-process restart
      // scheduler so idle drain and restart coalescing stay consistent.
      scheduleGatewaySigusr1Restart({ delayMs: 0, reason: "SIGUSR1" });
      return;
    }
    markGatewaySigusr1RestartHandled();
    request("restart", "SIGUSR1");
  };

  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  process.on("SIGUSR1", onSigusr1);

  try {
    const onIteration = createRestartIterationHook(() => {
      // After an in-process restart (SIGUSR1), reset command-queue lane state.
      // Interrupted tasks from the previous lifecycle may have left `active`
      // counts elevated (their finally blocks never ran), permanently blocking
      // new work from draining. This must happen here — at the restart
      // coordinator level — rather than inside individual subsystem init
      // functions, to avoid surprising cross-cutting side effects.
      resetAllLanes();
    });

    // Keep process alive; SIGUSR1 triggers an in-process restart (no supervisor required).
    // SIGTERM/SIGINT still exit after a graceful shutdown.
    let isFirstStart = true;
    for (;;) {
      onIteration();
      let resolveRestartIteration: (() => void) | null = null;
      const restartRequested = new Promise<void>((resolve) => {
        resolveRestartIteration = resolve;
      });
      restartResolver = () => {
        resolveRestartIteration?.();
      };
      const startupSnapshot = await readCurrentConfigSnapshotBestEffort();
      const startupConfigPath = resolveEffectiveConfigPath(startupSnapshot?.path);
      const startupHash = startupSnapshot ? resolveConfigSnapshotHash(startupSnapshot) : null;
      const lastKnownGood = await readLastKnownGoodBestEffort(startupConfigPath);
      try {
        startingServerPromise = params.start({ startupStartedAt });
        server = await startingServerPromise;
        startingServerPromise = null;
        const readiness = await waitForServerReadiness(server);
        if (readiness.status === "aborted") {
          await restartRequested;
          shuttingDown = false;
          pendingSignalAction = null;
          continue;
        }
        if (readiness.status === "timeout") {
          gatewayLog.warn(
            `gateway readiness did not become healthy after startup (${readiness.failing.join(", ") || "timeout"}); preserving existing last-known-good config`,
          );
        }
        const healthySnapshot = await readCurrentConfigSnapshotBestEffort();
        const healthyConfigPath = resolveEffectiveConfigPath(
          healthySnapshot?.path ?? startupConfigPath,
        );
        const healthyHash = healthySnapshot ? resolveConfigSnapshotHash(healthySnapshot) : null;
        const shouldPromoteLastKnownGood =
          healthySnapshot?.valid === true &&
          readiness.status === "ready" &&
          (healthyHash === null || !lastKnownGood || healthyHash !== lastKnownGood.hash);
        if (shouldPromoteLastKnownGood) {
          await persistEffectiveConfigLastKnownGood(healthySnapshot).catch((err) => {
            gatewayLog.warn(`failed to persist last-known-good config snapshot: ${String(err)}`);
          });
        } else if (readiness.status === "ready" && healthySnapshot && !healthySnapshot.valid) {
          gatewayLog.warn(
            `gateway started healthy but effective config snapshot at ${healthyConfigPath} was invalid; preserving existing last-known-good config`,
          );
        } else if (!lastKnownGood && !healthySnapshot) {
          gatewayLog.warn(
            `gateway started healthy but could not snapshot effective config at ${healthyConfigPath}`,
          );
        }
        isFirstStart = false;
      } catch (err) {
        startingServerPromise = null;
        const failedSnapshot = await readCurrentConfigSnapshotBestEffort();
        const failedConfigPath = resolveEffectiveConfigPath(
          failedSnapshot?.path ?? startupConfigPath,
        );
        const failedHash = failedSnapshot ? resolveConfigSnapshotHash(failedSnapshot) : startupHash;
        const failedLastKnownGood =
          lastKnownGood ?? (await readLastKnownGoodBestEffort(failedConfigPath));
        if (
          shouldAutoRecoverFromInvalidConfig({
            snapshot: failedSnapshot,
            currentHash: failedHash,
            lastKnownGoodHash: failedLastKnownGood?.hash ?? null,
          })
        ) {
          if (
            await recoverConfigAndContinue({
              configPath: failedConfigPath,
              reason: "startup-failure-after-config-change",
            })
          ) {
            continue;
          }
        }
        // On initial startup, let the error propagate so the outer handler
        // can report "Gateway failed to start" and exit non-zero. Only
        // swallow errors on subsequent in-process restarts to keep the
        // process alive (a crash would lose macOS TCC permissions). (#35862)
        if (isFirstStart) {
          throw err;
        }
        server = null;
        // Release the gateway lock so that `daemon restart/stop` (which
        // discovers PIDs via the gateway port) can still manage the process.
        // Without this, the process holds the lock but is not listening,
        // forcing manual cleanup. (#35862)
        await releaseLockIfHeld();
        const errMsg = formatErrorMessage(err);
        const errStack = err instanceof Error && err.stack ? `\n${err.stack}` : "";
        gatewayLog.error(
          `gateway startup failed: ${errMsg}. ` +
            `Process will stay alive; fix the issue and restart.${errStack}`,
        );
      }
      await restartRequested;
    }
  } finally {
    await releaseLockIfHeld();
    cleanupSignals();
  }
}
