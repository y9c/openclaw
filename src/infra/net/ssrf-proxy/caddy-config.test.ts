import { describe, it, expect } from "vitest";
import { isBlockedHostnameOrIp } from "../ssrf.js";
import {
  buildCaddySsrFProxyConfig,
  buildCaddySsrFProxyConfigJson,
  DEFAULT_BLOCKED_CIDRS,
  DEFAULT_BLOCKED_HOSTNAMES,
} from "./caddy-config.js";

describe("buildCaddySsrFProxyConfig", () => {
  it("produces a valid config object with the correct port", () => {
    const config = buildCaddySsrFProxyConfig({ port: 12345 });
    const server = (config as any).apps.http.servers["ssrf-proxy"];
    expect(server.listen).toEqual(["127.0.0.1:12345"]);
  });

  it("disables the Caddy admin API", () => {
    const config = buildCaddySsrFProxyConfig({ port: 9000 }) as any;
    expect(config.admin.disabled).toBe(true);
  });

  it("includes all default blocked CIDRs and hostnames in a deny ACL rule", () => {
    const config = buildCaddySsrFProxyConfig({ port: 9000 }) as any;
    const acl: any[] = config.apps.http.servers["ssrf-proxy"].routes[0].handle[0].acl;
    const denyRule = acl.find((r: any) => r.allow === false);
    expect(denyRule).toBeDefined();
    for (const cidr of DEFAULT_BLOCKED_CIDRS) {
      expect(denyRule.subjects).toContain(cidr);
    }
    for (const host of DEFAULT_BLOCKED_HOSTNAMES) {
      expect(denyRule.subjects).toContain(host);
    }
  });

  it.each([
    ["RFC2544 benchmarking range", "198.18.0.0/15", "198.18.0.1"],
    ["IPv6 unspecified", "::/128", "::"],
    ["IPv6 discard prefix", "100::/64", "100::1"],
    ["IPv6 benchmarking range", "2001:2::/48", "2001:2::1"],
    ["IPv6 ORCHIDv2", "2001:20::/28", "2001:20::1"],
    ["deprecated IPv6 site-local", "fec0::/10", "fec0::1"],
    ["NAT64 local-use prefix", "64:ff9b:1::/48", "64:ff9b:1::10.0.0.1"],
    ["6to4 with embedded private IPv4", "2002::/16", "2002:7f00:0001::"],
    ["Teredo with embedded private IPv4", "2001::/32", "2001:0000:0:0:0:0:80ff:fefe"],
  ])("blocks %s in both Caddy and app-level guards", (_name, cidr, representativeIp) => {
    expect(DEFAULT_BLOCKED_CIDRS).toContain(cidr);
    expect(isBlockedHostnameOrIp(representativeIp)).toBe(true);
  });

  it("appends extraBlockedCidrs to the deny rule", () => {
    const config = buildCaddySsrFProxyConfig({
      port: 9000,
      extraBlockedCidrs: ["203.0.113.0/24"],
    }) as any;
    const acl: any[] = config.apps.http.servers["ssrf-proxy"].routes[0].handle[0].acl;
    const denyRule = acl.find((r: any) => r.allow === false);
    expect(denyRule.subjects).toContain("203.0.113.0/24");
  });

  it("inserts extraAllowedHosts as ALLOW rules before the deny rule", () => {
    const config = buildCaddySsrFProxyConfig({
      port: 9000,
      extraAllowedHosts: ["internal-api.corp.example.com"],
    }) as any;
    const acl: any[] = config.apps.http.servers["ssrf-proxy"].routes[0].handle[0].acl;
    const allowIdx = acl.findIndex(
      (r: any) => r.allow === true && r.subjects?.includes("internal-api.corp.example.com"),
    );
    const denyIdx = acl.findIndex((r: any) => r.allow === false);
    expect(allowIdx).toBeGreaterThanOrEqual(0);
    expect(allowIdx).toBeLessThan(denyIdx);
  });

  it("adds an allow-all rule as the last ACL entry", () => {
    const config = buildCaddySsrFProxyConfig({ port: 9000 }) as any;
    const acl: any[] = config.apps.http.servers["ssrf-proxy"].routes[0].handle[0].acl;
    const last = acl[acl.length - 1];
    expect(last).toEqual({ subjects: ["all"], allow: true });
  });

  it("rejects upstreamProxy because forwardproxy upstream is incompatible with ACL", () => {
    expect(() =>
      buildCaddySsrFProxyConfig({
        port: 9000,
        upstreamProxy: "http://proxy.corp.example.com:8080",
      }),
    ).toThrow(/upstream proxy.*ACL/u);
  });

  it("does not set upstream when upstreamProxy is not provided", () => {
    const config = buildCaddySsrFProxyConfig({ port: 9000 }) as any;
    const handler = config.apps.http.servers["ssrf-proxy"].routes[0].handle[0];
    expect(handler.upstream).toBeUndefined();
  });

  it("hides IP and Via header by default", () => {
    const config = buildCaddySsrFProxyConfig({ port: 9000 }) as any;
    const handler = config.apps.http.servers["ssrf-proxy"].routes[0].handle[0];
    expect(handler.hide_ip).toBe(true);
    expect(handler.hide_via).toBe(true);
  });
});

describe("buildCaddySsrFProxyConfigJson", () => {
  it("returns valid JSON", () => {
    const json = buildCaddySsrFProxyConfigJson({ port: 9000 });
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("includes the port in the JSON output", () => {
    const json = buildCaddySsrFProxyConfigJson({ port: 7777 });
    expect(json).toContain("127.0.0.1:7777");
  });
});
