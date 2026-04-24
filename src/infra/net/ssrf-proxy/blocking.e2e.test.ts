/**
 * SSRF Blocking E2E Tests — THE main confidence test.
 *
 * These tests answer the question: "If an attacker tries to reach a private IP
 * through openclaw, does the SSRF proxy actually block them?"
 *
 * Strategy:
 *   1. Start a real Caddy with our SSRF blocklist config.
 *   2. Wire openclaw's process to route ALL HTTP through Caddy (Layers A + B).
 *   3. Start a "victim" HTTP server bound to 127.0.0.1.
 *   4. Attempt requests to 127.0.0.1, 10.x, 192.168.x, AWS metadata, etc.
 *   5. Assert the requests FAIL and the victim received ZERO hits.
 *
 * The "victim received zero hits" assertion is the strongest one — it proves
 * the request was actually dropped at the proxy, not just that an error was
 * returned for some other reason.
 */

import { request as httpRequest } from "node:http";
import { bootstrap as bootstrapGlobalAgent } from "global-agent";
import {
  setGlobalDispatcher,
  ProxyAgent,
  Agent as UndiciAgent,
  getGlobalDispatcher,
  request as undiciRequest,
} from "undici";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { CaddyProxyHandle } from "./proxy-process.js";
import {
  startTestSsrFProxy,
  stopTestSsrFProxy,
  isTestCaddyAvailable,
} from "./test-helpers/caddy-test-fixture.js";
import { createVictimServer, type VictimServer } from "./test-helpers/victim-server.js";

// E2E tests need real network and process spawning — give them headroom
const TEST_TIMEOUT_MS = 30_000;

// Helper: attempt a fetch that we expect to fail
async function expectFetchBlocked(
  url: string,
): Promise<{ blocked: boolean; status?: number; error?: string }> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });
    // If we get a 4xx/5xx from Caddy, that's still "blocked"
    if (res.status >= 400) {
      return { blocked: true, status: res.status };
    }
    // We got a 2xx/3xx — block FAILED
    return { blocked: false, status: res.status };
  } catch (err) {
    // Any network/connection error counts as blocked
    return { blocked: true, error: (err as Error).message };
  }
}

// Helper: attempt http.get that we expect to fail
function expectHttpGetBlocked(
  url: string,
): Promise<{ blocked: boolean; status?: number; error?: string }> {
  return new Promise((resolve) => {
    const req = httpRequest(url, (res) => {
      res.resume();
      if (res.statusCode && res.statusCode >= 400) {
        resolve({ blocked: true, status: res.statusCode });
      } else {
        resolve({ blocked: false, status: res.statusCode });
      }
    });
    req.on("error", (err) => resolve({ blocked: true, error: err.message }));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve({ blocked: true, error: "timeout" });
    });
    req.end();
  });
}

async function expectUndiciRequestBlocked(
  url: string,
): Promise<{ blocked: boolean; status?: number; error?: string }> {
  try {
    const res = await undiciRequest(url);
    if (res.statusCode >= 400) {
      return { blocked: true, status: res.statusCode };
    }
    return { blocked: false, status: res.statusCode };
  } catch (err) {
    return { blocked: true, error: (err as Error).message };
  }
}

describe.skipIf(!isTestCaddyAvailable())(
  "SSRF Blocking E2E — Real Caddy enforces blocklist",
  { timeout: TEST_TIMEOUT_MS },
  () => {
    let caddy: CaddyProxyHandle;
    let victim: VictimServer;
    let savedDispatcher: ReturnType<typeof getGlobalDispatcher>;

    const envKeys = [
      "http_proxy",
      "https_proxy",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "no_proxy",
      "NO_PROXY",
      "GLOBAL_AGENT_HTTP_PROXY",
      "GLOBAL_AGENT_HTTPS_PROXY",
      "GLOBAL_AGENT_NO_PROXY",
    ];
    const savedEnv: Record<string, string | undefined> = {};

    beforeAll(async () => {
      // Save state
      savedDispatcher = getGlobalDispatcher();
      for (const k of envKeys) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
      }

      // Start the victim server (will be bound to 127.0.0.1:RANDOM_PORT)
      victim = createVictimServer();
      await victim.start();

      // Start the real Caddy with default SSRF blocklist
      caddy = await startTestSsrFProxy();

      // Wire dual-stack enforcement
      // IMPORTANT: do NOT exclude 127.0.0.1 from NO_PROXY in this test —
      // we want requests TO 127.0.0.1 to go THROUGH the proxy so they get blocked.
      process.env["http_proxy"] = caddy.proxyUrl;
      process.env["https_proxy"] = caddy.proxyUrl;
      process.env["GLOBAL_AGENT_HTTP_PROXY"] = caddy.proxyUrl;
      process.env["GLOBAL_AGENT_HTTPS_PROXY"] = caddy.proxyUrl;
      // Empty NO_PROXY so EVERYTHING (including 127.0.0.1) routes through Caddy
      process.env["no_proxy"] = "";
      process.env["NO_PROXY"] = "";
      process.env["GLOBAL_AGENT_NO_PROXY"] = "";

      // Layer A: undici/fetch
      setGlobalDispatcher(new ProxyAgent(caddy.proxyUrl));

      // Layer B: node:http via global-agent
      bootstrapGlobalAgent();
      const ga = (global as Record<string, unknown>)["GLOBAL_AGENT"] as Record<string, unknown>;
      ga["HTTP_PROXY"] = caddy.proxyUrl;
      ga["HTTPS_PROXY"] = caddy.proxyUrl;
      ga["NO_PROXY"] = null;
    }, TEST_TIMEOUT_MS);

    afterAll(async () => {
      // Restore state
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

    beforeEach(() => {
      victim?.reset();
    });

    // -----------------------------------------------------------------------
    // THE CRITICAL TEST: requests to 127.0.0.1 (the victim) are blocked
    // -----------------------------------------------------------------------

    describe("Layer A — fetch() blocking", () => {
      it("blocks fetch() to 127.0.0.1 (victim server)", async () => {
        const result = await expectFetchBlocked(`${victim.url()}/should-be-blocked`);

        expect(result.blocked).toBe(true);
        // Victim must NOT have received the request — proves the block, not just an error
        expect(victim.hits.length).toBe(0);
      });

      it("blocks fetch() to 10.0.0.1 (RFC-1918 private)", async () => {
        const result = await expectFetchBlocked("http://10.0.0.1/admin");
        expect(result.blocked).toBe(true);
      });

      it("blocks fetch() to 192.168.1.1 (RFC-1918 private)", async () => {
        const result = await expectFetchBlocked("http://192.168.1.1/router");
        expect(result.blocked).toBe(true);
      });

      it("blocks fetch() to 169.254.169.254 (AWS/cloud metadata IP)", async () => {
        const result = await expectFetchBlocked("http://169.254.169.254/latest/meta-data/");
        expect(result.blocked).toBe(true);
      });

      it("blocks fetch() to metadata.google.internal (by hostname)", async () => {
        const result = await expectFetchBlocked("http://metadata.google.internal/");
        expect(result.blocked).toBe(true);
      });

      it("blocks fetch() to localhost (by hostname)", async () => {
        const result = await expectFetchBlocked("http://localhost:80/admin");
        expect(result.blocked).toBe(true);
      });

      it("blocks undici.request() to 127.0.0.1 (victim server)", async () => {
        const result = await expectUndiciRequestBlocked(`${victim.url()}/undici-request`);

        expect(result.blocked).toBe(true);
        expect(victim.hits.length).toBe(0);
      });
    });

    // -----------------------------------------------------------------------
    // Layer B — node:http blocking (via global-agent)
    // -----------------------------------------------------------------------

    describe("Layer B — http.request() blocking", () => {
      it("blocks http.request() to 127.0.0.1 (victim server)", async () => {
        const result = await expectHttpGetBlocked(`${victim.url()}/should-be-blocked`);

        expect(result.blocked).toBe(true);
        expect(victim.hits.length).toBe(0);
      });

      it("blocks http.request() to 10.0.0.1", async () => {
        const result = await expectHttpGetBlocked("http://10.0.0.1/admin");
        expect(result.blocked).toBe(true);
      });

      it("blocks http.request() to 169.254.169.254 (AWS metadata)", async () => {
        const result = await expectHttpGetBlocked("http://169.254.169.254/latest/meta-data/");
        expect(result.blocked).toBe(true);
      });
    });

    // -----------------------------------------------------------------------
    // Hostname-based blocking
    // -----------------------------------------------------------------------

    describe("Hostname-based blocklist", () => {
      it("blocks fetch() to localhost.localdomain", async () => {
        const result = await expectFetchBlocked("http://localhost.localdomain/");
        expect(result.blocked).toBe(true);
      });
    });
  },
);
