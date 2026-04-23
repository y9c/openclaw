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

/** Whether global-agent has already been bootstrapped in this process */
let globalAgentBootstrapped = false;

/**
 * Reset the bootstrapped flag — for use in tests only.
 * @internal
 */
export function _resetGlobalAgentBootstrapForTests(): void {
  globalAgentBootstrapped = false;
}

/**
 * Hosts that should always bypass the proxy — the loopback itself plus
 * any existing NO_PROXY entries from the operator environment.
 */
function buildNoProxy(existingNoProxy: string | undefined): string {
  const parts: string[] = ["127.0.0.1", "::1", "localhost"];
  if (existingNoProxy) {
    parts.push(existingNoProxy);
  }
  return parts.join(",");
}

/**
 * Injects the proxy URL into process.env for both enforcement layers:
 *  - http_proxy/https_proxy (lowercase) → undici EnvHttpProxyAgent (Layer A)
 *  - HTTP_PROXY/HTTPS_PROXY (uppercase) → axios, curl, git, child processes
 *  - GLOBAL_AGENT_HTTP/HTTPS_PROXY      → global-agent bootstrap (Layer B)
 */
function injectProxyEnv(proxyUrl: string): void {
  // Layer A + general client compatibility (lowercase + uppercase)
  for (const key of PROXY_ENV_KEYS) {
    process.env[key] = proxyUrl;
  }
  // Layer B: global-agent (node:http / node:https stack)
  for (const key of GLOBAL_AGENT_PROXY_KEYS) {
    process.env[key] = proxyUrl;
  }
  // NO_PROXY: preserve any operator-supplied value and add loopback exclusions
  const existingNoProxy = process.env["no_proxy"] ?? process.env["NO_PROXY"];
  const noProxy = buildNoProxy(existingNoProxy);
  process.env["no_proxy"] = noProxy;
  process.env["NO_PROXY"] = noProxy;
  process.env["GLOBAL_AGENT_NO_PROXY"] = noProxy;
}

/**
 * Removes the proxy URL from process.env when the proxy stops.
 * This is best-effort; the process is likely shutting down anyway.
 */
function removeProxyEnv(proxyUrl: string): void {
  for (const key of PROXY_ENV_KEYS) {
    if (process.env[key] === proxyUrl) {
      delete process.env[key];
    }
  }
  for (const key of GLOBAL_AGENT_PROXY_KEYS) {
    if (process.env[key] === proxyUrl) {
      delete process.env[key];
    }
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
  // Proxy is opt-out: enabled by default unless explicitly disabled
  if (config?.enabled === false) {
    logInfo("ssrf-proxy: disabled by configuration — using application-level SSRF guards only");
    return null;
  }

  // F1: Warn loudly when extraAllowedHosts is configured. Allowed hosts bypass
  // ALL IP-based deny rules (RFC-1918, loopback, cloud metadata, etc.) and are
  // only as trustworthy as the DNS path that resolves them. See the JSDoc on
  // CaddySsrFProxyConfigOptions.extraAllowedHosts for full details.
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

  // Forward declaration so the onUnexpectedExit closure can reach the URL we
  // injected. Set after startCaddyProxy resolves.
  let injectedProxyUrl: string | null = null;

  const handleUnexpectedCaddyExit = (): void => {
    // Caddy crashed. The http_proxy env vars still point at a now-dead loopback
    // port; without intervention every outbound HTTP request would hard-fail
    // with ECONNREFUSED. Clear the env vars, reset both enforcement layers,
    // so openclaw degrades back to application-level fetchWithSsrFGuard guards.
    if (injectedProxyUrl != null) {
      removeProxyEnv(injectedProxyUrl);
      injectedProxyUrl = null;
    }

    // Layer A: reset undici's global dispatcher so fetch() stops using ProxyAgent
    try {
      forceResetGlobalDispatcher();
    } catch (err) {
      logWarn(`ssrf-proxy: failed to reset undici dispatcher after Caddy crash: ${String(err)}`);
    }

    // Layer B: clear global-agent's runtime proxy URLs so http.request/https.request
    // stop routing through the dead proxy port
    try {
      if (
        typeof global !== "undefined" &&
        (global as Record<string, unknown>)["GLOBAL_AGENT"] != null
      ) {
        const agent = (global as Record<string, unknown>)["GLOBAL_AGENT"] as Record<
          string,
          unknown
        >;
        agent["HTTP_PROXY"] = "";
        agent["HTTPS_PROXY"] = "";
      }
    } catch (err) {
      logWarn(`ssrf-proxy: failed to reset global-agent after Caddy crash: ${String(err)}`);
    }

    logWarn(
      "ssrf-proxy: cleared proxy env vars and reset both enforcement layers — " +
        "subsequent requests will use application-level SSRF guards only.",
    );
  };

  const processOptions: CaddyProcessOptions = {
    binaryPath: config?.binaryPath,
    extraBlockedCidrs: config?.extraBlockedCidrs,
    extraAllowedHosts: config?.extraAllowedHosts,
    upstreamProxy: config?.userProxy,
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

  // Step 1: Inject proxy URL into process.env BEFORE activating both layers.
  injectProxyEnv(handle.proxyUrl);
  injectedProxyUrl = handle.proxyUrl;

  // Step 2 — Layer A: Force undici's global dispatcher to pick up the new env
  // vars immediately. Without this, ensureGlobalUndiciEnvProxyDispatcher() would
  // be a no-op because it was already called at CLI startup.
  forceResetGlobalDispatcher();

  // Step 3 — Layer B: Bootstrap global-agent to monkey-patch node:http / node:https.
  // This covers axios, got, and any other library that uses the http.request stack.
  bootstrapNodeHttpStack(handle.proxyUrl);

  logInfo(
    `ssrf-proxy: dual-stack network-level SSRF protection active via ${handle.proxyUrl}\n` +
      `  Layer A (undici/fetch): global dispatcher set to ProxyAgent\n` +
      `  Layer B (http/https):   global-agent bootstrapped`,
  );

  const ssrfHandle: SsrFProxyHandle = {
    ...handle,
    injectedProxyUrl: handle.proxyUrl,
    stop: async () => {
      // Mark as cleared so that if Caddy's exit handler also fires, it won't
      // double-clear or log an extra "degraded" warning.
      if (injectedProxyUrl != null) {
        removeProxyEnv(injectedProxyUrl);
        injectedProxyUrl = null;
      }

      // Mirror the crash handler logic: removing env vars alone is not enough
      // because both enforcement layers cache the proxy target separately
      // from process.env. Without resetting them, subsequent requests would
      // continue to route through the now-dead proxy port (ECONNREFUSED).

      // Layer A: reset undici's global dispatcher so fetch() stops using the
      // ProxyAgent that was installed when the proxy was started.
      try {
        forceResetGlobalDispatcher();
      } catch (err) {
        logWarn(`ssrf-proxy: failed to reset undici dispatcher on stop: ${String(err)}`);
      }

      // Layer B: clear global-agent's runtime proxy URLs so http.request /
      // https.request stop routing through the dead proxy port.
      try {
        if (
          typeof global !== "undefined" &&
          (global as Record<string, unknown>)["GLOBAL_AGENT"] != null
        ) {
          const agent = (global as Record<string, unknown>)["GLOBAL_AGENT"] as Record<
            string,
            unknown
          >;
          agent["HTTP_PROXY"] = "";
          agent["HTTPS_PROXY"] = "";
        }
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
