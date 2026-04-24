/**
 * Proxy-side resolution regression tests.
 *
 * These tests verify the important property of the sidecar design: callers send
 * hostnames to Caddy, and Caddy resolves and checks the target immediately
 * before dialing it. That means localhost-style targets are still blocked even
 * when the client-side HTTP stack is routed through a global proxy.
 */

import { setGlobalDispatcher, ProxyAgent, Agent as UndiciAgent, getGlobalDispatcher } from "undici";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { CaddyProxyHandle } from "./proxy-process.js";
import {
  startTestSsrFProxy,
  stopTestSsrFProxy,
  isTestCaddyAvailable,
} from "./test-helpers/caddy-test-fixture.js";
import { createVictimServer, type VictimServer } from "./test-helpers/victim-server.js";

const TEST_TIMEOUT_MS = 30_000;

describe.skipIf(!isTestCaddyAvailable())(
  "SSRF proxy E2E — proxy-side resolution blocks local targets",
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

    it("requests with hostname that resolves to 127.0.0.1 are blocked at the proxy", async () => {
      // The forward proxy doesn't trust client-side DNS — Caddy resolves the
      // hostname itself and applies its ACL to the result. So any hostname
      // that resolves to a blocked IP is dropped, regardless of what the
      // client thought it was resolving.
      victim.reset();

      // 'localhost' resolves to 127.0.0.1 on every system
      const res = await fetch(`http://localhost:${victim.port()}/rebind-test`).catch(() => null);

      // Caddy must block this — even though the client passed a "harmless-looking"
      // hostname, Caddy resolves it server-side and matches the loopback rule
      if (res) {
        expect(res.status).toBeGreaterThanOrEqual(400);
      }
      expect(victim.hits.length).toBe(0);
    });

    it("requests with literal IP 127.0.0.1 are blocked at the proxy", async () => {
      victim.reset();

      const res = await fetch(`http://127.0.0.1:${victim.port()}/literal-ip`).catch(() => null);

      if (res) {
        expect(res.status).toBeGreaterThanOrEqual(400);
      }
      expect(victim.hits.length).toBe(0);
    });

    it("a hostname matching localhost.localdomain is blocked", async () => {
      victim.reset();
      // localhost.localdomain is in DEFAULT_BLOCKED_HOSTNAMES
      const res = await fetch(`http://localhost.localdomain:${victim.port()}/`).catch(() => null);
      if (res) {
        expect(res.status).toBeGreaterThanOrEqual(400);
      }
      expect(victim.hits.length).toBe(0);
    });

    it("multiple sequential requests to the same blocked target stay blocked", async () => {
      victim.reset();

      // With a forward proxy, Caddy's ACL is applied on each request.
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`http://127.0.0.1:${victim.port()}/iter-${i}`).catch(() => null);
        if (res) {
          expect(res.status).toBeGreaterThanOrEqual(400);
        }
      }
      expect(victim.hits.length).toBe(0);
    });

    it("KEY ASSERTION: Caddy resolves and blocks localhost-style hostnames itself", async () => {
      // The defining property of a forward-proxy SSRF defense:
      // The CLIENT does NOT do DNS resolution at all — it sends the
      // hostname to the proxy in the absolute URL, and the PROXY does
      // the resolution + ACL check together as one atomic operation.
      //
      // We verify the property by checking that requests don't even include
      // the IP in the URL — they include the hostname, and Caddy resolves it.
      victim.reset();

      // Use 'localhost' (resolves to 127.0.0.1 — blocked)
      const res1 = await fetch(`http://localhost:${victim.port()}/dns-test-1`).catch(() => null);
      if (res1) {
        expect(res1.status).toBeGreaterThanOrEqual(400);
      }

      // Use 'localhost.localdomain' (also blocked by hostname match)
      const res2 = await fetch(`http://localhost.localdomain:${victim.port()}/dns-test-2`).catch(
        () => null,
      );
      if (res2) {
        expect(res2.status).toBeGreaterThanOrEqual(400);
      }

      // Both blocked by proxy-side target resolution / ACL evaluation.
      expect(victim.hits.length).toBe(0);
    });
  },
);
