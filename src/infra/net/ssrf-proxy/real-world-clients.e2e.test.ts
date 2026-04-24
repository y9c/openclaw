/**
 * Real-world HTTP client patterns e2e test.
 *
 * Verifies that the dual-stack enforcement covers the request patterns used
 * by popular Node.js HTTP libraries:
 *   - axios (uses http.request internally with explicit Agent)
 *   - got (uses http.request with custom Agent)
 *   - node-fetch v2 (uses http.request)
 *   - request (deprecated but still in many projects, uses http.request)
 *
 * We don't install these libraries (would bloat deps); instead we replicate
 * their critical patterns:
 *   - Passing an explicit `agent: new http.Agent()` (axios pattern)
 *   - Passing options object with hostname+port instead of URL (request pattern)
 *   - Using http.get with a URL string (node-fetch v2 pattern)
 */

import http, { Agent as HttpAgent } from "node:http";
import { bootstrap as bootstrapGlobalAgent } from "global-agent";
import { setGlobalDispatcher, ProxyAgent, Agent as UndiciAgent, getGlobalDispatcher } from "undici";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { CaddyProxyHandle } from "./proxy-process.js";
import {
  startTestSsrFProxy,
  stopTestSsrFProxy,
  isTestCaddyAvailable,
} from "./test-helpers/caddy-test-fixture.js";
import { createVictimServer, type VictimServer } from "./test-helpers/victim-server.js";

const TEST_TIMEOUT_MS = 30_000;

// Helper: simulate an HTTP request and resolve to {status, error}
function tryRequest(
  opts: http.RequestOptions | string | URL,
): Promise<{ status?: number; error?: string }> {
  return new Promise((resolve) => {
    const req = http.request(opts as http.RequestOptions, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on("error", (err) => resolve({ error: err.message }));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve({ error: "timeout" });
    });
    req.end();
  });
}

describe.skipIf(!isTestCaddyAvailable())(
  "SSRF Real-World Client Patterns E2E",
  { timeout: TEST_TIMEOUT_MS },
  () => {
    let caddy: CaddyProxyHandle;
    let victim: VictimServer;
    let savedDispatcher: ReturnType<typeof getGlobalDispatcher>;

    const envKeys = [
      "GLOBAL_AGENT_HTTP_PROXY",
      "GLOBAL_AGENT_HTTPS_PROXY",
      "GLOBAL_AGENT_NO_PROXY",
    ];
    const savedEnv: Record<string, string | undefined> = {};

    beforeAll(async () => {
      savedDispatcher = getGlobalDispatcher();
      for (const k of envKeys) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
      }

      victim = createVictimServer();
      await victim.start();
      caddy = await startTestSsrFProxy();

      process.env["GLOBAL_AGENT_HTTP_PROXY"] = caddy.proxyUrl;
      process.env["GLOBAL_AGENT_HTTPS_PROXY"] = caddy.proxyUrl;
      process.env["GLOBAL_AGENT_NO_PROXY"] = "";

      setGlobalDispatcher(new ProxyAgent(caddy.proxyUrl));
      bootstrapGlobalAgent();
      const ga = (global as Record<string, unknown>)["GLOBAL_AGENT"] as Record<string, unknown>;
      ga["HTTP_PROXY"] = caddy.proxyUrl;
      ga["HTTPS_PROXY"] = caddy.proxyUrl;
      ga["NO_PROXY"] = null;
    });

    afterAll(async () => {
      setGlobalDispatcher(savedDispatcher ?? new UndiciAgent());
      for (const k of envKeys) {
        if (savedEnv[k] === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = savedEnv[k];
        }
      }
      await stopTestSsrFProxy(caddy);
      await victim?.stop();
    });

    beforeEach(() => victim?.reset());

    it("axios pattern (URL string + http.request) — blocked", async () => {
      const r = await tryRequest(`http://127.0.0.1:${victim.port()}/axios-pattern`);
      if (r.status !== undefined) {
        expect(r.status).toBeGreaterThanOrEqual(400);
      }
      expect(victim.hits.length).toBe(0);
    });

    it("axios pattern (explicit new http.Agent — common axios config) — global-agent overrides it", async () => {
      // global-agent's forceGlobalAgent=true should override even an explicit
      // user-supplied agent. This is the critical bypass-prevention property.
      const customAgent = new HttpAgent({ keepAlive: true });
      const r = await tryRequest({
        hostname: "127.0.0.1",
        port: victim.port(),
        path: "/axios-with-agent",
        agent: customAgent,
      });
      if (r.status !== undefined) {
        expect(r.status).toBeGreaterThanOrEqual(400);
      }
      expect(victim.hits.length).toBe(0);
    });

    it("request library pattern (options object with hostname/port/path) — blocked", async () => {
      const r = await tryRequest({
        hostname: "127.0.0.1",
        port: victim.port(),
        path: "/request-lib-pattern",
        method: "POST",
      });
      if (r.status !== undefined) {
        expect(r.status).toBeGreaterThanOrEqual(400);
      }
      expect(victim.hits.length).toBe(0);
    });

    it("got pattern (URL object + custom Agent) — blocked", async () => {
      // got passes URL objects and uses a custom Agent for keep-alive
      const targetUrl = new URL(`http://127.0.0.1:${victim.port()}/got-pattern`);
      const r = await tryRequest({
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: "GET",
        agent: new HttpAgent({ keepAlive: true, maxSockets: 10 }),
      });
      expect(r.error).toBeUndefined();
      if (r.status === undefined) {
        throw new Error("expected Caddy to return a denial response");
      }
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(victim.hits.length).toBe(0);
    });

    it("node-fetch v2 pattern (http.request from URL string) — blocked", async () => {
      const r = await tryRequest(new URL(`http://127.0.0.1:${victim.port()}/node-fetch-pattern`));
      if (r.status !== undefined) {
        expect(r.status).toBeGreaterThanOrEqual(400);
      }
      expect(victim.hits.length).toBe(0);
    });

    it("multiple http.Agent instances — none of them bypass the proxy", async () => {
      // Create 5 different agent instances and use each — all should be intercepted
      for (let i = 0; i < 5; i++) {
        const agent = new HttpAgent({ keepAlive: i % 2 === 0, maxSockets: i + 1 });
        const r = await tryRequest({
          hostname: "127.0.0.1",
          port: victim.port(),
          path: `/multi-agent-${i}`,
          agent,
        });
        if (r.status !== undefined) {
          expect(r.status).toBeGreaterThanOrEqual(400);
        }
      }
      expect(victim.hits.length).toBe(0);
    });
  },
);
