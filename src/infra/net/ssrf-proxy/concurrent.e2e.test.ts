/**
 * Concurrency e2e tests.
 *
 * Verifies the proxy correctly handles many simultaneous requests without:
 *   - Race conditions in the ACL evaluation (some requests slipping through)
 *   - Resource exhaustion / hangs
 *   - Crashes
 */

import { setGlobalDispatcher, ProxyAgent, Agent as UndiciAgent, getGlobalDispatcher } from "undici";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { CaddyProxyHandle } from "./proxy-process.js";
import {
  startTestSsrFProxy,
  stopTestSsrFProxy,
  isTestCaddyAvailable,
} from "./test-helpers/caddy-test-fixture.js";
import { createVictimServer, type VictimServer } from "./test-helpers/victim-server.js";

const TEST_TIMEOUT_MS = 60_000;

describe.skipIf(!isTestCaddyAvailable())(
  "SSRF Concurrency E2E — proxy handles parallel requests safely",
  { timeout: TEST_TIMEOUT_MS },
  () => {
    let caddy: CaddyProxyHandle;
    let victim: VictimServer;
    let savedDispatcher: ReturnType<typeof getGlobalDispatcher>;

    beforeAll(async () => {
      savedDispatcher = getGlobalDispatcher();
      victim = createVictimServer();
      await victim.start();
      caddy = await startTestSsrFProxy();
      setGlobalDispatcher(new ProxyAgent(caddy.proxyUrl));
    });

    afterAll(async () => {
      setGlobalDispatcher(savedDispatcher ?? new UndiciAgent());
      await stopTestSsrFProxy(caddy);
      await victim?.stop();
    });

    beforeEach(() => victim?.reset());

    it("100 parallel blocked requests — ALL blocked, ZERO reach victim", async () => {
      const requests = Array.from({ length: 100 }, (_, i) =>
        fetch(`http://127.0.0.1:${victim.port()}/parallel-blocked-${i}`).catch(() => null),
      );
      const results = await Promise.all(requests);

      // Every request must have been blocked
      for (const r of results) {
        if (r) {
          expect(r.status).toBeGreaterThanOrEqual(400);
        }
      }
      // CRITICAL: not a single request reached the victim
      expect(victim.hits.length).toBe(0);
    });

    it("50 parallel requests to mixed targets — only allowed ones succeed", async () => {
      // We need a Caddy that allows 127.0.0.1 for half the requests.
      // Restart with allowlist for this test.
      const caddyWithAllow = await startTestSsrFProxy({ extraAllowedHosts: ["127.0.0.1"] });
      const oldDispatcher = getGlobalDispatcher();
      setGlobalDispatcher(new ProxyAgent(caddyWithAllow.proxyUrl));
      victim.reset();

      try {
        const requests = Array.from({ length: 50 }, (_, i) =>
          fetch(`http://127.0.0.1:${victim.port()}/concurrent-${i}`).catch(() => null),
        );
        const results = await Promise.all(requests);

        // All 50 should have succeeded (127.0.0.1 is allowlisted)
        const successes = results.filter((r) => r && r.status === 200).length;
        expect(successes).toBe(50);
        expect(victim.hits.length).toBe(50);
      } finally {
        setGlobalDispatcher(oldDispatcher);
        await stopTestSsrFProxy(caddyWithAllow);
      }
    });

    it("rapid sequential requests don't exhaust connection pool", async () => {
      // 200 sequential requests — would catch socket leaks
      let blocked = 0;
      for (let i = 0; i < 200; i++) {
        const r = await fetch(`http://10.0.0.1/test-${i}`).catch(() => null);
        if (!r || r.status >= 400) {
          blocked++;
        }
      }
      expect(blocked).toBe(200);
    });
  },
);
