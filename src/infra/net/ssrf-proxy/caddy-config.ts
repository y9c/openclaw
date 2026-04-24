/**
 * Generates a Caddy JSON configuration for the openclaw SSRF-blocking forward proxy.
 *
 * The Caddy sidecar is the network-level enforcement point that blocks connections
 * to private/internal IP ranges at TOU (time-of-use), inside the proxy when it
 * resolves and dials the target. This closes the DNS-rebinding TOCTOU window
 * that exists in application-level DNS pinning.
 *
 * Requires the caddy-forwardproxy plugin:
 *   https://github.com/caddyserver/forwardproxy
 */

/** Default CIDRs that are always blocked (RFC-1918, loopback, link-local, CGNAT, etc.) */
export const DEFAULT_BLOCKED_CIDRS: readonly string[] = [
  // IPv4 loopback
  "127.0.0.0/8",
  // IPv4 "this network" (SSRF bypass vector on some OS stacks)
  "0.0.0.0/8",
  // IPv4 link-local
  "169.254.0.0/16",
  // RFC-1918 private ranges
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  // CGNAT / shared address space (RFC 6598)
  "100.64.0.0/10",
  // RFC 2544 benchmarking range
  "198.18.0.0/15",
  // IETF protocol assignments / special-use ranges
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "198.51.100.0/24",
  "203.0.113.0/24",
  // IPv4 multicast
  "224.0.0.0/4",
  // IPv4 reserved / broadcast
  "240.0.0.0/4",
  // IPv6 loopback
  "::1/128",
  // IPv6 unspecified
  "::/128",
  // IPv6 discard prefix
  "100::/64",
  // IPv6 link-local
  "fe80::/10",
  // IPv6 ULA (unique local addresses – private)
  "fc00::/7",
  // Deprecated IPv6 site-local
  "fec0::/10",
  // IPv6 multicast
  "ff00::/8",
  // IPv6 benchmarking range
  "2001:2::/48",
  // IPv6 ORCHIDv2
  "2001:20::/28",
  // IPv6 documentation prefix
  "2001:db8::/32",
  // Well-known NAT64 prefix with embedded IPv4
  "64:ff9b::/96",
  // NAT64 local-use prefix with embedded IPv4
  "64:ff9b:1::/48",
  // 6to4 prefix with embedded IPv4
  "2002::/16",
  // Teredo prefix with embedded IPv4
  "2001::/32",
  // Deprecated IPv4-compatible IPv6 addresses
  "::/96",
  // IPv4-mapped IPv6 addresses
  "::ffff:0:0/96",
];

/** Well-known hostnames that must always be blocked regardless of IP resolution */
export const DEFAULT_BLOCKED_HOSTNAMES: readonly string[] = [
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
];

export type CaddySsrFProxyConfigOptions = {
  /** Port to listen on (loopback only). */
  port: number;
  /**
   * Extra CIDRs to block in addition to the defaults.
   * These are appended to DEFAULT_BLOCKED_CIDRS.
   */
  extraBlockedCidrs?: string[];
  /**
   * Hostnames allowed before IP deny rules run. Only use for names with a
   * trusted DNS path, because a hijacked allowed hostname can point at an
   * otherwise-blocked internal address.
   */
  extraAllowedHosts?: string[];
  /**
   * Reserved until upstream chaining can preserve ACL enforcement. Passing a
   * value currently throws instead of generating an unsafe Caddy config.
   */
  upstreamProxy?: string;
};

/**
 * Builds the Caddy JSON config object for the SSRF-blocking forward proxy.
 *
 * ACL evaluation order (Caddy forwardproxy):
 *   1. ALLOW rules for user-specified allowed hosts  ← inserted first
 *   2. DENY rules for blocked CIDRs + hostnames      ← private ranges
 *   3. ALLOW all (pass-through to public internet)   ← final default
 *
 * This means: if a hostname is in extraAllowedHosts, it bypasses the deny
 * rules even if it happens to resolve to a private IP. Everything else that
 * resolves to a blocked CIDR is denied at TOU.
 */
export function buildCaddySsrFProxyConfig(options: CaddySsrFProxyConfigOptions): object {
  const { port, extraBlockedCidrs = [], extraAllowedHosts = [], upstreamProxy } = options;

  if (upstreamProxy) {
    throw new Error("ssrf-proxy: upstream proxy mode is incompatible with Caddy ACL enforcement");
  }

  const blockedCidrs = [...DEFAULT_BLOCKED_CIDRS, ...extraBlockedCidrs];

  const acl: object[] = [];

  if (extraAllowedHosts.length > 0) {
    acl.push({ subjects: [...extraAllowedHosts], allow: true });
  }

  acl.push({
    subjects: [...DEFAULT_BLOCKED_HOSTNAMES, ...blockedCidrs],
    allow: false,
  });

  acl.push({ subjects: ["all"], allow: true });

  const handlerConfig: Record<string, unknown> = {
    handler: "forward_proxy",
    hide_ip: true,
    hide_via: true,
    acl,
  };

  return {
    apps: {
      http: {
        servers: {
          "ssrf-proxy": {
            listen: [`127.0.0.1:${port}`],
            logs: {
              default_logger_name: "openclaw-ssrf-proxy",
            },
            routes: [
              {
                handle: [handlerConfig],
              },
            ],
          },
        },
      },
    },
    admin: {
      disabled: true,
    },
    logging: {
      logs: {
        "openclaw-ssrf-proxy": {
          writer: {
            output: "stderr",
          },
          encoder: {
            format: "json",
          },
          level: "WARN",
        },
      },
    },
  };
}

/**
 * Serializes the Caddy config to JSON for passing to `caddy run --config -`.
 */
export function buildCaddySsrFProxyConfigJson(options: CaddySsrFProxyConfigOptions): string {
  return JSON.stringify(buildCaddySsrFProxyConfig(options), null, 2);
}
