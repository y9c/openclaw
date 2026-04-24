/**
 * Unit tests for proxy-lifecycle.ts — dual-stack env var injection.
 *
 * These tests verify that startSsrFProxy correctly sets the env vars for both
 * enforcement layers without actually spawning a Caddy process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the heavy dependencies before importing the module under test
vi.mock("./proxy-process.js", () => ({
  startCaddyProxy: vi.fn(),
}));

vi.mock("../undici-global-dispatcher.js", () => ({
  forceResetGlobalDispatcher: vi.fn(),
}));

vi.mock("global-agent", () => ({
  bootstrap: vi.fn(),
  createGlobalProxyAgent: vi.fn(),
}));

vi.mock("../../../logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { bootstrap as bootstrapGlobalAgent } from "global-agent";
import { forceResetGlobalDispatcher } from "../undici-global-dispatcher.js";
import {
  startSsrFProxy,
  stopSsrFProxy,
  _resetGlobalAgentBootstrapForTests,
} from "./proxy-lifecycle.js";
import { startCaddyProxy } from "./proxy-process.js";

const mockStartCaddyProxy = vi.mocked(startCaddyProxy);
const mockForceResetGlobalDispatcher = vi.mocked(forceResetGlobalDispatcher);
const mockBootstrapGlobalAgent = vi.mocked(bootstrapGlobalAgent);

function makeFakeHandle(port = 19876) {
  const proxyUrl = `http://127.0.0.1:${port}`;
  return {
    port,
    proxyUrl,
    pid: 99999,
    stop: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn(),
  };
}

describe("startSsrFProxy — env var injection", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeysToClean = [
    "http_proxy",
    "https_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "no_proxy",
    "NO_PROXY",
    "GLOBAL_AGENT_HTTP_PROXY",
    "GLOBAL_AGENT_HTTPS_PROXY",
    "GLOBAL_AGENT_FORCE_GLOBAL_AGENT",
    "GLOBAL_AGENT_NO_PROXY",
  ];

  beforeEach(() => {
    // Save and clear proxy-related env vars
    for (const key of envKeysToClean) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Reset mocks
    mockStartCaddyProxy.mockReset();
    mockForceResetGlobalDispatcher.mockReset();
    mockBootstrapGlobalAgent.mockReset();
    // Reset the module-level bootstrapped flag so each test gets a clean slate
    _resetGlobalAgentBootstrapForTests();
    (global as Record<string, unknown>)["GLOBAL_AGENT"] = undefined;
  });

  afterEach(() => {
    // Restore env vars
    for (const key of envKeysToClean) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("returns null and does not touch env when enabled is false", async () => {
    const handle = await startSsrFProxy({ enabled: false });
    expect(handle).toBeNull();
    expect(process.env["http_proxy"]).toBeUndefined();
    expect(process.env["GLOBAL_AGENT_HTTP_PROXY"]).toBeUndefined();
  });

  it("returns null and does not touch env when not explicitly enabled", async () => {
    const handle = await startSsrFProxy(undefined);
    expect(handle).toBeNull();
    expect(mockStartCaddyProxy).not.toHaveBeenCalled();
    expect(process.env["http_proxy"]).toBeUndefined();
    expect(process.env["GLOBAL_AGENT_HTTP_PROXY"]).toBeUndefined();
  });

  it("returns null and logs warning when Caddy fails to start", async () => {
    mockStartCaddyProxy.mockRejectedValue(new Error("caddy not found"));
    const handle = await startSsrFProxy({ enabled: true });
    expect(handle).toBeNull();
    expect(process.env["http_proxy"]).toBeUndefined();
  });

  it("returns null when an ambient proxy env var is already configured", async () => {
    process.env["HTTPS_PROXY"] = "http://corp-proxy.example.com:8080";

    const handle = await startSsrFProxy({ enabled: true });

    expect(handle).toBeNull();
    expect(mockStartCaddyProxy).not.toHaveBeenCalled();
    expect(process.env["HTTPS_PROXY"]).toBe("http://corp-proxy.example.com:8080");
  });

  it("sets Layer A env vars (undici) when Caddy starts successfully", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    await startSsrFProxy({ enabled: true });

    // Lowercase — read by undici's EnvHttpProxyAgent
    expect(process.env["http_proxy"]).toBe(fake.proxyUrl);
    expect(process.env["https_proxy"]).toBe(fake.proxyUrl);
    // Uppercase — read by axios, curl, git, and most other HTTP clients
    expect(process.env["HTTP_PROXY"]).toBe(fake.proxyUrl);
    expect(process.env["HTTPS_PROXY"]).toBe(fake.proxyUrl);
  });

  it("sets Layer B env vars (global-agent) when Caddy starts successfully", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    await startSsrFProxy({ enabled: true });

    expect(process.env["GLOBAL_AGENT_HTTP_PROXY"]).toBe(fake.proxyUrl);
    expect(process.env["GLOBAL_AGENT_HTTPS_PROXY"]).toBe(fake.proxyUrl);
    expect(process.env["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"]).toBe("true");
  });

  it("forces global-agent even when the operator env disabled it before startup", async () => {
    process.env["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"] = "false";
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);
    (global as Record<string, unknown>)["GLOBAL_AGENT"] = {
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      forceGlobalAgent: false,
    };

    const handle = await startSsrFProxy({ enabled: true });
    expect(handle).not.toBeNull();

    const agent = (global as Record<string, unknown>)["GLOBAL_AGENT"] as Record<string, unknown>;
    expect(process.env["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"]).toBe("true");
    expect(agent["forceGlobalAgent"]).toBe(true);

    await stopSsrFProxy(handle);

    expect(process.env["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"]).toBe("false");
    expect(agent["forceGlobalAgent"]).toBe(false);
  });

  it("clears NO_PROXY so loopback targets still go through Caddy", async () => {
    process.env["NO_PROXY"] = "127.0.0.1,localhost,corp.example.com";
    process.env["no_proxy"] = "localhost";
    process.env["GLOBAL_AGENT_NO_PROXY"] = "localhost";
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    await startSsrFProxy({ enabled: true });

    expect(process.env["no_proxy"]).toBe("");
    expect(process.env["NO_PROXY"]).toBe("");
    expect(process.env["GLOBAL_AGENT_NO_PROXY"]).toBe("");
  });

  it("restores previous proxy environment values on stop", async () => {
    process.env["NO_PROXY"] = "corp.example.com";
    process.env["GLOBAL_AGENT_NO_PROXY"] = "global.corp.example.com";
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    const handle = await startSsrFProxy({ enabled: true });
    expect(handle).not.toBeNull();

    expect(process.env["HTTP_PROXY"]).toBe(fake.proxyUrl);
    expect(process.env["NO_PROXY"]).toBe("");
    expect(process.env["GLOBAL_AGENT_NO_PROXY"]).toBe("");

    await stopSsrFProxy(handle);

    expect(process.env["HTTP_PROXY"]).toBeUndefined();
    expect(process.env["NO_PROXY"]).toBe("corp.example.com");
    expect(process.env["GLOBAL_AGENT_NO_PROXY"]).toBe("global.corp.example.com");
  });

  it("calls forceResetGlobalDispatcher (Layer A activation)", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    await startSsrFProxy({ enabled: true });

    expect(mockForceResetGlobalDispatcher).toHaveBeenCalledOnce();
  });

  it("calls global-agent bootstrap (Layer B activation) on first proxy start", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    await startSsrFProxy({ enabled: true });

    // bootstrap() must be called exactly once (flag is reset in beforeEach)
    expect(mockBootstrapGlobalAgent).toHaveBeenCalledOnce();
  });

  it("does NOT call global-agent bootstrap again on subsequent proxy starts", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    // First start (bootstraps)
    await startSsrFProxy({ enabled: true });
    // Second start (should skip bootstrap since flag is set)
    await startSsrFProxy({ enabled: true });

    expect(mockBootstrapGlobalAgent).toHaveBeenCalledOnce();
  });

  it("removes proxy env vars when handle.stop() is called", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    const handle = await startSsrFProxy({ enabled: true });
    expect(handle).not.toBeNull();

    await stopSsrFProxy(handle);

    // Lowercase
    expect(process.env["http_proxy"]).toBeUndefined();
    expect(process.env["https_proxy"]).toBeUndefined();
    // Uppercase
    expect(process.env["HTTP_PROXY"]).toBeUndefined();
    expect(process.env["HTTPS_PROXY"]).toBeUndefined();
    // global-agent namespace
    expect(process.env["GLOBAL_AGENT_HTTP_PROXY"]).toBeUndefined();
    expect(process.env["GLOBAL_AGENT_HTTPS_PROXY"]).toBeUndefined();
    expect(process.env["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"]).toBeUndefined();
  });

  it("stops Caddy and restores env when undici activation fails", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);
    mockForceResetGlobalDispatcher.mockImplementationOnce(() => {
      throw new Error("dispatcher failed");
    });

    const handle = await startSsrFProxy({ enabled: true });

    expect(handle).toBeNull();
    expect(fake.stop).toHaveBeenCalledOnce();
    expect(process.env["http_proxy"]).toBeUndefined();
    expect(process.env["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"]).toBeUndefined();
  });

  it("stops Caddy and restores env when global-agent bootstrap fails", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);
    mockBootstrapGlobalAgent.mockImplementationOnce(() => {
      throw new Error("bootstrap failed");
    });

    const handle = await startSsrFProxy({ enabled: true });

    expect(handle).toBeNull();
    expect(fake.stop).toHaveBeenCalledOnce();
    expect(process.env["http_proxy"]).toBeUndefined();
    expect(process.env["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"]).toBeUndefined();
  });

  it("calls forceResetGlobalDispatcher on stop() (Layer A reset)", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    const handle = await startSsrFProxy({ enabled: true });
    expect(handle).not.toBeNull();

    // First call: Layer A activation during start. Reset so we can isolate the
    // stop() reset call below.
    expect(mockForceResetGlobalDispatcher).toHaveBeenCalledOnce();
    mockForceResetGlobalDispatcher.mockClear();

    await stopSsrFProxy(handle);

    // stop() must reset Layer A so fetch() stops routing through the dead port.
    // Without this, undici's cached ProxyAgent dispatcher would continue to
    // forward requests to a closed loopback port (ECONNREFUSED).
    expect(mockForceResetGlobalDispatcher).toHaveBeenCalledOnce();
  });

  it("restores global.GLOBAL_AGENT proxy URLs on stop() (Layer B reset)", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);
    process.env["GLOBAL_AGENT_HTTP_PROXY"] = "http://previous-global.example.com:8080";
    process.env["GLOBAL_AGENT_HTTPS_PROXY"] = "http://previous-global.example.com:8443";
    process.env["GLOBAL_AGENT_NO_PROXY"] = "corp.example.com";

    // Pre-seed global.GLOBAL_AGENT to mimic the post-bootstrap state where
    // global-agent has installed its agent object on the global scope. The
    // bootstrap mock does not actually create this object, so the test owns
    // the setup here.
    (global as Record<string, unknown>)["GLOBAL_AGENT"] = {
      HTTP_PROXY: fake.proxyUrl,
      HTTPS_PROXY: fake.proxyUrl,
    };

    const handle = await startSsrFProxy({ enabled: true });
    expect(handle).not.toBeNull();

    // Sanity check: bootstrap path on real start would set these to fake.proxyUrl.
    const agent = (global as Record<string, unknown>)["GLOBAL_AGENT"] as Record<string, unknown>;
    expect(agent["HTTP_PROXY"]).toBe(fake.proxyUrl);
    expect(agent["HTTPS_PROXY"]).toBe(fake.proxyUrl);

    await stopSsrFProxy(handle);

    // stop() must reset Layer B so http.request / https.request stop routing
    // through the dead proxy port while preserving the user's prior settings.
    expect(agent["HTTP_PROXY"]).toBe("http://previous-global.example.com:8080");
    expect(agent["HTTPS_PROXY"]).toBe("http://previous-global.example.com:8443");
    expect(agent["NO_PROXY"]).toBe("corp.example.com");
  });

  it("passes binaryPath from config to startCaddyProxy", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    await startSsrFProxy({ enabled: true, binaryPath: "/custom/caddy" });

    expect(mockStartCaddyProxy).toHaveBeenCalledWith(
      expect.objectContaining({ binaryPath: "/custom/caddy" }),
    );
  });

  it("passes extraBlockedCidrs from config to startCaddyProxy", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    await startSsrFProxy({ enabled: true, extraBlockedCidrs: ["203.0.113.0/24"] });

    expect(mockStartCaddyProxy).toHaveBeenCalledWith(
      expect.objectContaining({ extraBlockedCidrs: ["203.0.113.0/24"] }),
    );
  });

  it("passes extraAllowedHosts from config to startCaddyProxy", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    await startSsrFProxy({ enabled: true, extraAllowedHosts: ["internal.corp"] });

    expect(mockStartCaddyProxy).toHaveBeenCalledWith(
      expect.objectContaining({ extraAllowedHosts: ["internal.corp"] }),
    );
  });

  it("stopSsrFProxy is a no-op when handle is null", async () => {
    await expect(stopSsrFProxy(null)).resolves.toBeUndefined();
  });
});
