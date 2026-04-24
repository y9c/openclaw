/**
 * High-level lifecycle management for the openclaw SSRF network proxy.
 *
 * Usage (in daemon/CLI startup):
 *
 *   const handle = await startSsrFProxy(config?.ssrfProxy);
 *   // handle is null if proxy is disabled or unavailable
 *
 *   // On shutdown:
 *   await stopSsrFProxy(handle);
 *
 * When the proxy starts successfully it wires up TWO enforcement layers:
 *
 *   Layer A — undici / global fetch():
 *     Calls forceResetGlobalDispatcher() which installs an EnvHttpProxyAgent
 *     as the undici global dispatcher. Because Node 18+ fetch() is backed by
 *     undici, this covers fetch() and all undici.request() calls.
 *
 *   Layer B — node:http / node:https stack (axios, got, etc.):
 *     Calls bootstrap() from the `global-agent` package, which monkey-patches
 *     http.request, http.get, https.request, https.get to force every request
 *     through our proxy agent — even if the caller explicitly set their own
 *     agent (forceGlobalAgent: true).
 *
 * Together these two layers cover essentially all HTTP traffic in the Node.js
 * process. The only realistic gaps are native C++ addons making raw syscalls
 * and child processes spawning external binaries (curl, wget) — neither of
 * which openclaw uses for outbound HTTP.
 *
 * If Caddy is not available or disabled, a warning is logged and the function
 * returns null — application-level fetchWithSsrFGuard protections remain active.
 */

import { bootstrap as bootstrapGlobalAgent } from "global-agent";
import { logInfo, logWarn } from "../../../logger.js";
import { forceResetGlobalDispatcher } from "../undici-global-dispatcher.js";
import type { SsrFProxyConfig } from "./proxy-config-schema.js";
import {
  startCaddyProxy,
  type CaddyProcessOptions,
  type CaddyProxyHandle,
} from "./proxy-process.js";

export type SsrFProxyHandle = CaddyProxyHandle & {
  /** The proxy URL that was injected into process.env */
  injectedProxyUrl: string;
  /** Original proxy-related environment values, restored on stop/crash. */
  envSnapshot: ProxyEnvSnapshot;
};

/**
 * The environment variable keys we set when the proxy starts.
 * We set BOTH lowercase and uppercase variants because:
 *   - undici's EnvHttpProxyAgent reads lowercase http_proxy/https_proxy
 *   - axios, requests-style libraries, and many other clients check the
 *     uppercase HTTP_PROXY/HTTPS_PROXY variants
 *   - child processes / spawned binaries (curl, git, etc.) typically read
 *     the uppercase form too
 * We additionally inject the GLOBAL_AGENT_ namespaced variants for
 * global-agent's bootstrap (Layer B).
 */
const PROXY_ENV_KEYS = ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"] as const;
const GLOBAL_AGENT_PROXY_KEYS = ["GLOBAL_AGENT_HTTP_PROXY", "GLOBAL_AGENT_HTTPS_PROXY"] as const;
const GLOBAL_AGENT_FORCE_KEYS = ["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"] as const;
const NO_PROXY_ENV_KEYS = ["no_proxy", "NO_PROXY", "GLOBAL_AGENT_NO_PROXY"] as const;
const ALL_PROXY_ENV_KEYS = [
  ...PROXY_ENV_KEYS,
  ...GLOBAL_AGENT_PROXY_KEYS,
  ...GLOBAL_AGENT_FORCE_KEYS,
  ...NO_PROXY_ENV_KEYS,
] as const;
type ProxyEnvKey = (typeof ALL_PROXY_ENV_KEYS)[number];
type ProxyEnvSnapshot = Record<ProxyEnvKey, string | undefined>;

/** Whether global-agent has already been bootstrapped in this process */
let globalAgentBootstrapped = false;

/**
 * Reset the bootstrapped flag — for use in tests only.
 * @internal
 */
export function _resetGlobalAgentBootstrapForTests(): void {
  globalAgentBootstrapped = false;
}

function captureProxyEnv(): ProxyEnvSnapshot {
  return {
    http_proxy: process.env["http_proxy"],
    https_proxy: process.env["https_proxy"],
    HTTP_PROXY: process.env["HTTP_PROXY"],
    HTTPS_PROXY: process.env["HTTPS_PROXY"],
    GLOBAL_AGENT_HTTP_PROXY: process.env["GLOBAL_AGENT_HTTP_PROXY"],
    GLOBAL_AGENT_HTTPS_PROXY: process.env["GLOBAL_AGENT_HTTPS_PROXY"],
    GLOBAL_AGENT_FORCE_GLOBAL_AGENT: process.env["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"],
    no_proxy: process.env["no_proxy"],
    NO_PROXY: process.env["NO_PROXY"],
    GLOBAL_AGENT_NO_PROXY: process.env["GLOBAL_AGENT_NO_PROXY"],
  };
}

/**
 * Injects the proxy URL into process.env for both enforcement layers:
 *  - http_proxy/https_proxy (lowercase) → undici EnvHttpProxyAgent (Layer A)
 *  - HTTP_PROXY/HTTPS_PROXY (uppercase) → axios, curl, git, child processes
 *  - GLOBAL_AGENT_HTTP/HTTPS_PROXY      → global-agent bootstrap (Layer B)
 */
function injectProxyEnv(proxyUrl: string): ProxyEnvSnapshot {
  const snapshot = captureProxyEnv();
  // Layer A + general client compatibility (lowercase + uppercase)
  for (const key of PROXY_ENV_KEYS) {
    process.env[key] = proxyUrl;
  }
  // Layer B: global-agent (node:http / node:https stack)
  for (const key of GLOBAL_AGENT_PROXY_KEYS) {
    process.env[key] = proxyUrl;
  }
  process.env["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"] = "true";
  // NO_PROXY is target-based. Leaving loopback or operator-provided bypasses
  // here would let those destinations skip the Caddy ACL entirely.
  for (const key of NO_PROXY_ENV_KEYS) {
    process.env[key] = "";
  }
  return snapshot;
}

/**
 * Restores proxy-related process.env entries when the proxy stops.
 * This is best-effort; the process is likely shutting down anyway.
 */
function restoreProxyEnv(snapshot: ProxyEnvSnapshot): void {
  for (const key of ALL_PROXY_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function hasAmbientProxyEnv(snapshot: ProxyEnvSnapshot): boolean {
  return PROXY_ENV_KEYS.some((key) => {
    const value = snapshot[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function restoreGlobalAgentRuntime(snapshot: ProxyEnvSnapshot): void {
  if (
    typeof global === "undefined" ||
    (global as Record<string, unknown>)["GLOBAL_AGENT"] == null
  ) {
    return;
  }
  const agent = (global as Record<string, unknown>)["GLOBAL_AGENT"] as Record<string, unknown>;
  agent["HTTP_PROXY"] = snapshot["GLOBAL_AGENT_HTTP_PROXY"] ?? "";
  agent["HTTPS_PROXY"] = snapshot["GLOBAL_AGENT_HTTPS_PROXY"] ?? "";
  agent["NO_PROXY"] = snapshot["GLOBAL_AGENT_NO_PROXY"] ?? null;
  const forceGlobalAgent = snapshot["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"];
  if (forceGlobalAgent === undefined) {
    delete agent["forceGlobalAgent"];
  } else {
    agent["forceGlobalAgent"] = forceGlobalAgent !== "false";
  }
}

/**
 * Bootstrap global-agent to intercept the node:http / node:https stack.
 *
 * global-agent monkey-patches http.request, http.get, https.request,
 * https.get to force every request through our proxy agent — even if the
 * caller explicitly set their own agent (forceGlobalAgent: true by default).
 *
 * After bootstrapping, the proxy URL can be updated at runtime by mutating
 * global.GLOBAL_AGENT.HTTP_PROXY and HTTPS_PROXY.
 */
function bootstrapNodeHttpStack(proxyUrl: string): void {
  if (!globalAgentBootstrapped) {
    // First time: run the full bootstrap which monkey-patches http/https
    bootstrapGlobalAgent();
    globalAgentBootstrapped = true;
  }

  // Update the runtime proxy URL (works both on first run and subsequent calls)
  if (
    typeof global !== "undefined" &&
    (global as Record<string, unknown>)["GLOBAL_AGENT"] != null
  ) {
    const agent = (global as Record<string, unknown>)["GLOBAL_AGENT"] as Record<string, unknown>;
    agent["HTTP_PROXY"] = proxyUrl;
    agent["HTTPS_PROXY"] = proxyUrl;
    agent["NO_PROXY"] = process.env["GLOBAL_AGENT_NO_PROXY"];
    agent["forceGlobalAgent"] = true;
  }
}

/**
 * Start the SSRF network proxy sidecar.
 *
 * Returns a handle on success, or null if the proxy is disabled or unavailable.
 * If null is returned, openclaw falls back to application-level fetchWithSsrFGuard
 * protections (existing behaviour).
 */
export async function startSsrFProxy(
  config: SsrFProxyConfig | undefined,
): Promise<SsrFProxyHandle | null> {
  // Require explicit opt-in; app-level SSRF guards remain active when disabled.
  if (config?.enabled !== true) {
    logInfo("ssrf-proxy: disabled — using application-level SSRF guards only");
    return null;
  }

  const startupEnvSnapshot = captureProxyEnv();
  if (hasAmbientProxyEnv(startupEnvSnapshot)) {
    logWarn(
      "ssrf-proxy: HTTP_PROXY/HTTPS_PROXY is already configured; skipping sidecar because " +
        "upstream proxy settings cannot be preserved yet. Using application-level SSRF guards only.",
    );
    return null;
  }

  if (config?.extraAllowedHosts && config.extraAllowedHosts.length > 0) {
    logWarn(
      `ssrf-proxy: extraAllowedHosts is configured (${config.extraAllowedHosts.length} entr${
        config.extraAllowedHosts.length === 1 ? "y" : "ies"
      }: ${config.extraAllowedHosts.join(", ")}). ` +
        `These hostnames BYPASS all IP-based deny rules (loopback, RFC-1918, cloud metadata). ` +
        `If an attacker can influence DNS for any of them (DNS hijacking, dangling subdomain, ` +
        `compromised resolver), they can target internal addresses. Only allow hosts whose DNS ` +
        `resolution path you fully trust. See docs/security/ssrf-proxy.md.`,
    );
  }

  // Captured after startCaddyProxy so crash cleanup can restore injected env.
  let injectedEnvSnapshot: ProxyEnvSnapshot | null = null;

  const handleUnexpectedCaddyExit = (): void => {
    // Restore proxy env and reset cached agents so requests do not keep using
    // the dead Caddy port.
    if (injectedEnvSnapshot != null) {
      restoreProxyEnv(injectedEnvSnapshot);
      injectedEnvSnapshot = null;
    }

    // Layer A: reset undici's global dispatcher so fetch() stops using ProxyAgent
    try {
      forceResetGlobalDispatcher();
    } catch (err) {
      logWarn(`ssrf-proxy: failed to reset undici dispatcher after Caddy crash: ${String(err)}`);
    }

    // Layer B: restore global-agent's runtime proxy URLs so http.request /
    // https.request stop routing through the dead proxy port.
    try {
      restoreGlobalAgentRuntime(startupEnvSnapshot);
    } catch (err) {
      logWarn(`ssrf-proxy: failed to reset global-agent after Caddy crash: ${String(err)}`);
    }

    logWarn(
      "ssrf-proxy: restored proxy env vars and reset both enforcement layers — " +
        "subsequent requests will use application-level SSRF guards only.",
    );
  };

  const processOptions: CaddyProcessOptions = {
    binaryPath: config?.binaryPath,
    extraBlockedCidrs: config?.extraBlockedCidrs,
    extraAllowedHosts: config?.extraAllowedHosts,
    upstreamProxy: undefined,
    onUnexpectedExit: handleUnexpectedCaddyExit,
  };

  let handle: CaddyProxyHandle;
  try {
    handle = await startCaddyProxy(processOptions);
  } catch (err) {
    logWarn(
      `ssrf-proxy: failed to start Caddy — falling back to application-level SSRF guards only.\n` +
        `  Reason: ${String(err)}\n` +
        `  The Caddy + forwardproxy binary is normally downloaded automatically during 'npm install openclaw'\n` +
        `  into '~/.openclaw/bin/caddy-ssrf'. If that download was skipped, blocked, or failed, you can\n` +
        `  recover by re-running the postinstall script:\n` +
        `      node ./node_modules/openclaw/scripts/postinstall-ssrf-caddy.mjs\n` +
        `  Or install caddy with the forwardproxy plugin manually and point 'ssrfProxy.binaryPath'\n` +
        `  (or OPENCLAW_CADDY_BINARY) at it. To suppress this warning entirely, set\n` +
        `  'ssrfProxy.enabled: false' in your openclaw config. See:\n` +
        `      https://docs.openclaw.ai/security/ssrf-proxy`,
    );
    return null;
  }

  try {
    // Step 1: Inject proxy URL into process.env BEFORE activating both layers.
    injectedEnvSnapshot = injectProxyEnv(handle.proxyUrl);

    // Step 2 — Layer A: Force undici's global dispatcher to pick up the new env
    // vars immediately. Without this, ensureGlobalUndiciEnvProxyDispatcher() would
    // be a no-op because it was already called at CLI startup.
    forceResetGlobalDispatcher();

    // Step 3 — Layer B: Bootstrap global-agent to monkey-patch node:http / node:https.
    // This covers axios, got, and any other library that uses the http.request stack.
    bootstrapNodeHttpStack(handle.proxyUrl);
  } catch (err) {
    if (injectedEnvSnapshot != null) {
      restoreProxyEnv(injectedEnvSnapshot);
      injectedEnvSnapshot = null;
    }
    try {
      restoreGlobalAgentRuntime(startupEnvSnapshot);
    } catch (restoreErr) {
      logWarn(
        `ssrf-proxy: failed to reset global-agent after activation failure: ${String(restoreErr)}`,
      );
    }
    try {
      forceResetGlobalDispatcher();
    } catch (resetErr) {
      logWarn(`ssrf-proxy: failed to reset undici after activation failure: ${String(resetErr)}`);
    }
    try {
      await handle.stop();
    } catch (stopErr) {
      logWarn(`ssrf-proxy: failed to stop Caddy after activation failure: ${String(stopErr)}`);
    }
    logWarn(
      `ssrf-proxy: failed to activate proxy enforcement — falling back to application-level SSRF guards only. Reason: ${String(err)}`,
    );
    return null;
  }

  logInfo(
    `ssrf-proxy: dual-stack network-level SSRF protection active via ${handle.proxyUrl}\n` +
      `  Layer A (undici/fetch): global dispatcher set to ProxyAgent\n` +
      `  Layer B (http/https):   global-agent bootstrapped`,
  );

  const ssrfHandle: SsrFProxyHandle = {
    ...handle,
    injectedProxyUrl: handle.proxyUrl,
    envSnapshot: injectedEnvSnapshot,
    stop: async () => {
      // Mark as restored so Caddy's exit handler skips duplicate cleanup.
      if (injectedEnvSnapshot != null) {
        restoreProxyEnv(injectedEnvSnapshot);
        injectedEnvSnapshot = null;
      }

      // Restoring process.env is not enough; both enforcement layers cache the
      // proxy target separately.

      // Layer A: reset undici's global dispatcher so fetch() stops using the
      // ProxyAgent that was installed when the proxy was started.
      try {
        forceResetGlobalDispatcher();
      } catch (err) {
        logWarn(`ssrf-proxy: failed to reset undici dispatcher on stop: ${String(err)}`);
      }

      // Layer B: restore global-agent's runtime proxy URLs so http.request /
      // https.request stop routing through the dead proxy port.
      try {
        restoreGlobalAgentRuntime(startupEnvSnapshot);
      } catch (err) {
        logWarn(`ssrf-proxy: failed to reset global-agent on stop: ${String(err)}`);
      }

      await handle.stop();
    },
  };

  return ssrfHandle;
}

/**
 * Stop the SSRF network proxy. Safe to call with null (no-op).
 */
export async function stopSsrFProxy(handle: SsrFProxyHandle | null): Promise<void> {
  if (!handle) {
    return;
  }
  await handle.stop();
}
