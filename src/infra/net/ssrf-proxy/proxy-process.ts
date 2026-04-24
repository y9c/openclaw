/**
 * Manages the Caddy forward proxy subprocess lifecycle for openclaw's
 * network-level SSRF protection.
 *
 * Responsibilities:
 *  - Pick a free loopback port
 *  - Locate the caddy binary
 *  - Spawn caddy with our generated config (via stdin)
 *  - Monitor for unexpected exits and emit warnings
 *  - Gracefully shut down on request
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createServer, createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { logInfo, logWarn } from "../../../logger.js";
import { buildCaddySsrFProxyConfigJson } from "./caddy-config.js";
import type { CaddySsrFProxyConfigOptions } from "./caddy-config.js";

export type CaddyProcessOptions = Omit<CaddySsrFProxyConfigOptions, "port"> & {
  /** Override path to the caddy binary. Defaults to resolving from PATH. */
  binaryPath?: string;
  /**
   * Optional callback invoked if the Caddy process exits unexpectedly
   * (i.e. not via stop()). The caller should use this to clean up any
   * proxy env vars / dispatcher state so requests degrade gracefully to
   * application-level guards instead of hard-failing on a dead port.
   */
  onUnexpectedExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
};

export type CaddyProxyHandle = {
  /** The port Caddy is listening on. */
  port: number;
  /** The proxy URL to set in environment variables. */
  proxyUrl: string;
  /** PID of the Caddy child process (undefined if not yet spawned). */
  pid: number | undefined;
  /** Gracefully stop the Caddy process. */
  stop: () => Promise<void>;
};

const CADDY_STARTUP_TIMEOUT_MS = 10_000;
const CADDY_HEALTHCHECK_INTERVAL_MS = 500;
const CADDY_GRACEFUL_STOP_TIMEOUT_MS = 5_000;
const CADDY_STARTUP_ATTEMPTS = 3;

/**
 * Picks a random free TCP port on the loopback interface.
 * Resolves to the port number.
 */
export async function pickFreeLocalhostPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to determine free port"));
        return;
      }
      const port = addr.port;
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(port);
        }
      });
    });
    server.on("error", reject);
  });
}

/**
 * Resolves the path to the caddy binary.
 *
 * Priority:
 *   1. Explicit `binaryPath` config option
 *   2. `OPENCLAW_CADDY_BINARY` environment variable
 *   3. Auto-downloaded binary at `~/.openclaw/bin/caddy-ssrf` (postinstall)
 *   4. `caddy` resolved from PATH
 */
export function resolveCaddyBinaryPath(binaryPath?: string): string {
  if (binaryPath) {
    return binaryPath;
  }
  const envPath = process.env["OPENCLAW_CADDY_BINARY"];
  if (typeof envPath === "string" && envPath.trim().length > 0) {
    return envPath.trim();
  }
  const autoPath = resolveAutoDownloadedCaddyPath();
  if (autoPath !== null) {
    return autoPath;
  }
  return "caddy";
}

/**
 * Returns the absolute path to the postinstall-managed Caddy binary if it
 * exists and is executable, otherwise null.
 *
 * Notes:
 *  - We resolve directly under `os.homedir()/.openclaw/bin` rather than
 *    threading the state-dir helper. The bin dir is intentionally a peer of
 *    the openclaw state directory so the binary is not commingled with
 *    session/log artifacts.
 *  - On Windows we look for the `.exe` variant.
 *  - `accessSync(..., X_OK)` is best-effort: on Windows X_OK collapses to
 *    F_OK, but the symlink/copy created by the postinstall script is always
 *    invoked with execute-bit set on POSIX, so this is the right gate.
 */
function resolveAutoDownloadedCaddyPath(): string | null {
  const binaryName = process.platform === "win32" ? "caddy-ssrf.exe" : "caddy-ssrf";
  const candidate = path.join(os.homedir(), ".openclaw", "bin", binaryName);
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Waits until the Caddy proxy is accepting TCP connections on the given port,
 * or throws if the timeout is exceeded or the process exits unexpectedly.
 */
async function waitForCaddyReady(params: {
  port: number;
  process: ChildProcess;
  timeoutMs: number;
}): Promise<void> {
  const { port, process: proc, timeoutMs } = params;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // Check if the process has already exited
    if (proc.exitCode !== null || proc.killed) {
      throw new Error(
        `Caddy process exited unexpectedly during startup (exit code: ${proc.exitCode})`,
      );
    }

    // Try connecting to the proxy port
    const ready = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ port, host: "127.0.0.1" }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
      socket.setTimeout(CADDY_HEALTHCHECK_INTERVAL_MS, () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (ready) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, CADDY_HEALTHCHECK_INTERVAL_MS));
  }

  throw new Error(`Caddy proxy did not become ready within ${timeoutMs}ms on port ${port}`);
}

/**
 * Spawns the Caddy forward proxy as a child process, waits for it to be ready,
 * and returns a handle to control it.
 *
 * Throws if caddy is not found or fails to start within the timeout.
 */
export async function startCaddyProxy(options: CaddyProcessOptions): Promise<CaddyProxyHandle> {
  const binaryPath = resolveCaddyBinaryPath(options.binaryPath);
  let lastError: unknown;

  for (let attempt = 1; attempt <= CADDY_STARTUP_ATTEMPTS; attempt++) {
    const port = await pickFreeLocalhostPort();
    try {
      return await startCaddyProxyOnPort(options, binaryPath, port);
    } catch (err) {
      lastError = err;
      if (!isAddressInUseStartupError(err) || attempt === CADDY_STARTUP_ATTEMPTS) {
        throw err;
      }
      logWarn(`ssrf-proxy: Caddy port ${port} was claimed during startup; retrying`);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function startCaddyProxyOnPort(
  options: CaddyProcessOptions,
  binaryPath: string,
  port: number,
): Promise<CaddyProxyHandle> {
  const configJson = buildCaddySsrFProxyConfigJson({
    port,
    extraBlockedCidrs: options.extraBlockedCidrs,
    extraAllowedHosts: options.extraAllowedHosts,
    upstreamProxy: options.upstreamProxy,
  });

  logInfo(`ssrf-proxy: starting Caddy on 127.0.0.1:${port} (binary: ${binaryPath})`);

  let proc: ChildProcess;
  const stderrLines: string[] = [];
  try {
    proc = spawn(binaryPath, ["run", "--config", "-"], {
      // Pass config via stdin
      stdio: ["pipe", "pipe", "pipe"],
      // Inherit a clean environment; don't let Caddy pick up unexpected proxy env vars
      env: {
        HOME: process.env["HOME"],
        PATH: process.env["PATH"],
        TMPDIR: process.env["TMPDIR"],
        TMP: process.env["TMP"],
        TEMP: process.env["TEMP"],
      },
    });
  } catch (err) {
    throw new Error(`ssrf-proxy: failed to spawn caddy binary "${binaryPath}": ${String(err)}`, {
      cause: err,
    });
  }

  // spawn() reports many failures (missing binary / ENOENT, EACCES, etc.) via
  // the child process 'error' event rather than synchronously throwing from
  // spawn(). Without this listener those errors would surface as an unhandled
  // 'error' event and crash the process. waitForCaddyReady will pick up the
  // resulting exit and reject with a useful message.
  let spawnError: Error | null = null;
  proc.on("error", (err: Error) => {
    spawnError = err;
    logWarn(`ssrf-proxy: Caddy process error: ${String(err)}`);
  });

  if (!proc.stdin) {
    proc.kill();
    throw new Error("ssrf-proxy: Caddy process stdin not available");
  }

  // If Caddy terminates quickly (e.g. bad build, missing forwardproxy module),
  // proc.stdin.write()/end() can emit EPIPE on the now-closed pipe. Suppress
  // it here — the underlying failure is reported via the process 'exit' /
  // 'error' events and surfaced by waitForCaddyReady below.
  proc.stdin.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") {
      logWarn(`ssrf-proxy: Caddy stdin error: ${String(err)}`);
    }
  });

  // Write the config JSON to Caddy's stdin and close it
  proc.stdin.write(configJson);
  proc.stdin.end();

  // Relay Caddy's stderr to our logger
  proc.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) {
      stderrLines.push(line);
      logWarn(`ssrf-proxy [caddy]: ${line}`);
    }
  });

  // Relay Caddy's stdout to our logger (verbose info)
  proc.stdout?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) {
      logInfo(`ssrf-proxy [caddy]: ${line}`);
    }
  });

  let stopped = false;

  proc.on("exit", (code, signal) => {
    if (!stopped) {
      logWarn(
        `ssrf-proxy: Caddy exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}). ` +
          `SSRF network-level protection is degraded — application-level guards remain active.`,
      );
      if (options.onUnexpectedExit) {
        try {
          options.onUnexpectedExit({ code, signal });
        } catch (err) {
          logWarn(`ssrf-proxy: onUnexpectedExit callback threw: ${String(err)}`);
        }
      }
    }
  });

  // Wait for Caddy to accept connections. Race against the 'error' event so
  // async spawn failures (ENOENT, EACCES) reject the startup promptly with a
  // useful message rather than waiting for the readiness timeout.
  let spawnErrorListener: ((err: Error) => void) | null = null;
  const spawnErrorPromise = new Promise<never>((_resolve, reject) => {
    spawnErrorListener = (err: Error): void => {
      reject(
        new Error(`ssrf-proxy: failed to spawn caddy binary "${binaryPath}": ${String(err)}`, {
          cause: err,
        }),
      );
    };
    proc.once("error", spawnErrorListener);
  });
  // If the readiness check wins the race we don't want a late spawn 'error'
  // event to surface as an unhandled rejection.
  spawnErrorPromise.catch(() => {});

  try {
    await Promise.race([
      waitForCaddyReady({
        port,
        process: proc,
        timeoutMs: CADDY_STARTUP_TIMEOUT_MS,
      }),
      spawnErrorPromise,
    ]);
  } catch (err) {
    proc.kill("SIGTERM");
    if (spawnError) {
      throw new Error(
        `ssrf-proxy: failed to spawn caddy binary "${binaryPath}": ${String(spawnError)}`,
        { cause: err },
      );
    }
    throw withCaddyStderr(err, stderrLines);
  } finally {
    if (spawnErrorListener) {
      proc.off("error", spawnErrorListener);
    }
  }

  logInfo(`ssrf-proxy: Caddy ready on 127.0.0.1:${port}`);

  const proxyUrl = `http://127.0.0.1:${port}`;

  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;

    if (proc.exitCode !== null || proc.killed) {
      return;
    }

    logInfo("ssrf-proxy: stopping Caddy");

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        logWarn("ssrf-proxy: Caddy did not stop gracefully, sending SIGKILL");
        proc.kill("SIGKILL");
        resolve();
      }, CADDY_GRACEFUL_STOP_TIMEOUT_MS);

      proc.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      proc.kill("SIGTERM");
    });
  };

  return { port, proxyUrl, pid: proc.pid, stop };
}

function withCaddyStderr(err: unknown, stderrLines: string[]): Error {
  const base = err instanceof Error ? err : new Error(String(err));
  if (stderrLines.length === 0) {
    return base;
  }
  return new Error(`${base.message}\n${stderrLines.join("\n")}`, { cause: base });
}

function isAddressInUseStartupError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /EADDRINUSE|address already in use|bind: address/u.test(message);
}
