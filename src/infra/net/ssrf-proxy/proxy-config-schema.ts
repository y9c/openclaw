/**
 * Zod schema and TypeScript types for the user-facing `ssrfProxy` configuration key.
 */

import { z } from "zod";

export const SsrFProxyConfigSchema = z
  .object({
    /**
     * Whether to enable the Caddy-based network-level SSRF proxy.
     * Default: false (disabled).
     *
     * Set to true to enable the proxy. When disabled, OpenClaw relies on
     * application-level fetchWithSsrFGuard protections.
     */
    enabled: z.boolean().optional(),

    /**
     * Explicit path to the caddy binary.
     * Default: resolves 'caddy' from PATH, or the OPENCLAW_CADDY_BINARY env var.
     *
     * Example: "/usr/local/bin/caddy"
     */
    binaryPath: z.string().optional(),

    /**
     * Additional CIDR ranges to block at the network level, on top of the
     * built-in defaults (RFC-1918, loopback, link-local, CGNAT, etc.).
     *
     * Example: ["203.0.113.0/24"]
     */
    extraBlockedCidrs: z.array(z.string()).optional(),

    /**
     * Hostnames that should be allowed through even if they resolve to
     * addresses in a normally-blocked range (e.g. internal corporate services).
     *
     * These are inserted as explicit ALLOW rules before all DENY rules in the
     * Caddy ACL, so they take precedence.
     *
     * Example: ["internal-api.corp.example.com"]
     */
    extraAllowedHosts: z.array(z.string()).optional(),

    /**
     * Reserved for a future upstream-proxy design. Caddy forwardproxy upstream
     * mode is incompatible with ACL enforcement, so accepting it here would
     * silently weaken the sidecar's SSRF guarantee.
     */
    userProxy: z.never().optional(),
  })
  .strict()
  .optional();

export type SsrFProxyConfig = z.infer<typeof SsrFProxyConfigSchema>;
