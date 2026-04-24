import { describe, it, expect } from "vitest";
import { SsrFProxyConfigSchema } from "./proxy-config-schema.js";

describe("SsrFProxyConfigSchema", () => {
  it("accepts undefined (optional)", () => {
    expect(SsrFProxyConfigSchema.parse(undefined)).toBeUndefined();
  });

  it("accepts an empty object", () => {
    expect(SsrFProxyConfigSchema.parse({})).toEqual({});
  });

  it("accepts a full valid config", () => {
    const result = SsrFProxyConfigSchema.parse({
      enabled: true,
      binaryPath: "/usr/local/bin/caddy",
      extraBlockedCidrs: ["203.0.113.0/24"],
      extraAllowedHosts: ["internal.corp.example.com"],
    });
    expect(result).toMatchObject({
      enabled: true,
      binaryPath: "/usr/local/bin/caddy",
    });
  });

  it("rejects userProxy because upstream chaining cannot preserve Caddy ACL enforcement", () => {
    expect(() =>
      SsrFProxyConfigSchema.parse({ userProxy: "http://proxy.corp.example.com:8080" }),
    ).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() => SsrFProxyConfigSchema.parse({ unknownKey: true })).toThrow();
  });

  it("accepts enabled: false to disable the proxy", () => {
    const result = SsrFProxyConfigSchema.parse({ enabled: false });
    expect(result?.enabled).toBe(false);
  });
});
