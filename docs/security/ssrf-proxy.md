# SSRF Network Proxy

openclaw ships with a **network-level SSRF (Server-Side Request Forgery) protection layer** powered by a [Caddy](https://caddyserver.com/) forward proxy sidecar. This is a defence-in-depth complement to the application-level `fetchWithSsrFGuard` DNS-pinning mechanism.

## Why a Network-Level Proxy?

Application-level DNS pinning (the existing `fetchWithSsrFGuard`) has a **TOCTOU (time-of-check / time-of-use) window**: it resolves DNS at check time and pins the IP, but a sufficiently fast DNS rebinding attack can swap the IP between the check and the actual TCP connection.

The Caddy sidecar eliminates this window by enforcing IP blocklists **at TOU** — after the TCP connection is established and the kernel has resolved the IP — making it impossible for a rebinding attack to bypass the block.

## How It Works

```
openclaw process
  ├─ Layer A: undici/fetch     ──┐
  │  (setGlobalDispatcher)        │
  │                                ▼
  ├─ Layer B: node:http/https  ──→ Caddy sidecar (loopback) ──→ Public Internet
  │  (global-agent bootstrap)      │
  │                          (Blocks RFC-1918, loopback,
  │                           link-local, CGNAT, etc. at TOU)
  └─ All other code...
```

### Dual-Stack Enforcement

openclaw uses **two complementary enforcement layers** to ensure all HTTP traffic
goes through the Caddy sidecar — because no single mechanism in Node.js covers
both `fetch()` and `node:http`/`node:https` simultaneously:

| Layer | Mechanism                                                                | Covers                                                                                                           |
| ----- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **A** | undici `setGlobalDispatcher(new ProxyAgent(...))`                        | `fetch()` (Node 18+ built-in) and direct `undici.request()` calls                                                |
| **B** | `global-agent` bootstrap (monkey-patches `http.request`/`https.request`) | axios, got, node-fetch, superagent, Stripe SDK, and **anything else** using the `node:http`/`node:https` modules |

Together these cover essentially all HTTP traffic in the Node.js process.
Bootstrapping order at startup:

1. Caddy subprocess launches on a random loopback port.
2. openclaw injects:
   - `http_proxy` / `https_proxy` + `HTTP_PROXY` / `HTTPS_PROXY` (Layer A — lowercase read by undici's `EnvHttpProxyAgent`; uppercase read by axios, curl, git, and most other HTTP clients)
   - `GLOBAL_AGENT_HTTP_PROXY` / `GLOBAL_AGENT_HTTPS_PROXY` (Layer B — picked up by `global-agent`)
   - `no_proxy` / `NO_PROXY` / `GLOBAL_AGENT_NO_PROXY` (loopback exclusions)
3. `forceResetGlobalDispatcher()` activates Layer A.
4. `bootstrap()` from `global-agent` activates Layer B.
5. From this point, **every** outbound HTTP request from any code in the process
   flows through Caddy.
6. On shutdown, env vars are removed and Caddy is gracefully stopped.

### What's NOT Covered

The two known gaps (intentional, very low-risk):

- **Native C++ addons** that make raw HTTP calls via system libraries — openclaw
  does not use any such addons for outbound HTTP.
- **Child processes spawning external binaries** like `curl` or `wget` — openclaw
  does not do this for outbound HTTP either.

For environments requiring 100% kernel-level guarantees (e.g. running as a
shared service), consider supplementing with OS-level firewall rules
(e.g. `iptables`/`nftables` on Linux, `pf` on macOS) to block outbound
connections to private ranges from the openclaw process uid/gid.

## Installation

The Caddy + `forwardproxy` binary is **downloaded automatically during `npm install openclaw`** into `~/.openclaw/bin/caddy-ssrf`. You do not need to install Caddy yourself or have the Go toolchain on your machine — the openclaw postinstall step (`scripts/postinstall-ssrf-caddy.mjs`) fetches a pinned, checksum-verified pre-built binary from the openclaw GitHub releases.

The binary resolution order at startup is:

1. `ssrfProxy.binaryPath` (explicit config)
2. `OPENCLAW_CADDY_BINARY` environment variable
3. `~/.openclaw/bin/caddy-ssrf` (the auto-downloaded binary)
4. `caddy` resolved from `PATH` (system fallback)

If none of those produce a working Caddy + `forwardproxy` binary, openclaw degrades gracefully to application-level SSRF guards only and logs a warning at startup.

### Skipping or recovering the auto-download

- Set `OPENCLAW_SKIP_CADDY_DOWNLOAD=1` before `npm install` to opt out entirely (useful for CI, Docker images you build separately, or airgapped environments).
- Set `OPENCLAW_NIX_MODE=1` to opt out and signal that the binary is managed via Nix instead.
- If the postinstall download was blocked or failed, you can re-run it any time with:

  ```bash
  node ./node_modules/openclaw/scripts/postinstall-ssrf-caddy.mjs
  ```

  The script is idempotent, checksum-verified, and never errors out — failures only emit warnings.

<details>
<summary>Advanced: build Caddy with forwardproxy yourself</summary>

If you need a custom build (different Caddy version, additional plugins, an unsupported platform, or a fully airgapped install), build Caddy yourself and either drop the binary at `~/.openclaw/bin/caddy-ssrf` or point `ssrfProxy.binaryPath` / `OPENCLAW_CADDY_BINARY` at it.

**Option 1 — Build with xcaddy:**

```bash
xcaddy build --with github.com/caddyserver/forwardproxy@caddy2
sudo mv caddy /usr/local/bin/caddy
```

**Option 2 — Download a pre-built binary:**
Visit [caddyserver.com/download](https://caddyserver.com/download) and add the `github.com/caddyserver/forwardproxy` plugin.

</details>

## Configuration

All options are under the `ssrfProxy` key in your openclaw config file:

```yaml
ssrfProxy:
  # Whether to enable the network-level proxy. Default: true.
  # Set to false to rely solely on application-level SSRF guards.
  enabled: true

  # Optional: path to the caddy binary.
  # Default: resolves 'caddy' from PATH, or the OPENCLAW_CADDY_BINARY env var.
  binaryPath: /usr/local/bin/caddy

  # Optional: additional CIDR ranges to block (added to built-in defaults).
  extraBlockedCidrs:
    - 203.0.113.0/24

  # Optional: hostnames to explicitly allow through (e.g. internal corporate services).
  # These bypass the CIDR blocklists — use sparingly.
  extraAllowedHosts:
    - internal-api.corp.example.com

  # Optional: upstream proxy URL for corporate proxy environments.
  # Caddy will forward requests through this proxy instead of connecting directly.
  userProxy: http://proxy.corp.example.com:8080
```

> ⚠️ **Security warning — `extraAllowedHosts` is a DNS resolution footgun**
>
> Hostnames listed in `extraAllowedHosts` **bypass every IP-based deny rule**,
> including loopback, RFC-1918, link-local, and cloud metadata IPs
> (`169.254.169.254`). The Caddy ACL is evaluated top-down with first-match-wins:
>
> 1. `ALLOW(extraAllowedHosts)` — short-circuits everything below
> 2. `DENY(blocked CIDRs + hostnames)`
> 3. `ALLOW(all)`
>
> Concretely: an attacker who controls DNS for any allowed hostname (DNS
> hijacking, compromised DNS provider, on-path attacker, dangling subdomain
> takeover) can re-point that hostname at `127.0.0.1`, the cloud metadata
> service, or any other internal address — and openclaw will follow.
>
> Only allow hostnames whose DNS resolution path you fully trust:
>
> - Internal hostnames served by an authenticated, internal-only DNS resolver
> - Names you own and operate end-to-end
> - Targets that cannot be silently re-pointed by a third party
>
> If you need to allow access to an internal service that resolves to an
> RFC-1918 address, prefer pinning at the network layer (host file entries,
> internal CA + mTLS) over DNS-based allowlisting.
>
> openclaw additionally logs a runtime warning at startup whenever
> `extraAllowedHosts` is non-empty so the operator is reminded of this risk.

> ⚠️ **Security warning — `userProxy` transfers SSRF trust to the upstream**
>
> When `userProxy` is set, Caddy forwards every outbound request to the
> configured upstream proxy instead of connecting directly to the target.
> openclaw can no longer enforce its own IP blocklist on the final hop —
> the upstream proxy decides what destinations are reachable.
>
> This means:
>
> - The upstream proxy **must enforce equivalent SSRF protections** (block
>   RFC-1918, loopback, link-local, cloud metadata, etc.). If it does not,
>   openclaw's network-level SSRF protection is effectively bypassed for
>   any traffic that flows through it.
> - The upstream proxy can see all openclaw outbound HTTP destinations and
>   (for plain HTTP) request bodies. Treat it as a fully privileged
>   network intermediary.
> - Compromise of the upstream proxy is equivalent to compromise of
>   openclaw's outbound network policy.
>
> Only set `userProxy` when:
>
> - The upstream proxy is operated by your organisation (or a trusted
>   third party with a documented SSRF posture), AND
> - You have verified that it blocks the same internal address ranges
>   openclaw blocks by default.
>
> If you only need to allow a few hostnames through openclaw's filter,
> prefer `extraAllowedHosts` (with the caveats above) instead of routing
> all traffic via an external proxy.

## Default Blocked Ranges

The following IP ranges are blocked by default:

| Range            | Description                                                   |
| ---------------- | ------------------------------------------------------------- |
| `127.0.0.0/8`    | IPv4 loopback                                                 |
| `0.0.0.0/8`      | IPv4 "this network" (SSRF bypass vector on some OS stacks)    |
| `169.254.0.0/16` | IPv4 link-local (covers AWS/Azure metadata `169.254.169.254`) |
| `10.0.0.0/8`     | RFC-1918 private                                              |
| `172.16.0.0/12`  | RFC-1918 private                                              |
| `192.168.0.0/16` | RFC-1918 private                                              |
| `100.64.0.0/10`  | CGNAT / shared address space                                  |
| `224.0.0.0/4`    | IPv4 multicast                                                |
| `240.0.0.0/4`    | IPv4 reserved                                                 |
| `::1/128`        | IPv6 loopback                                                 |
| `fe80::/10`      | IPv6 link-local                                               |
| `fc00::/7`       | IPv6 ULA (private)                                            |
| `ff00::/8`       | IPv6 multicast                                                |
| `::ffff:0:0/96`  | IPv4-mapped IPv6 (e.g. `::ffff:7f00:1` form of `127.0.0.1`)   |

The following hostnames are always blocked regardless of their resolved IP:

- `localhost`
- `localhost.localdomain`
- `metadata.google.internal`

## Graceful Degradation

If Caddy is not installed or fails to start, openclaw **does not crash**. Instead:

1. A warning is logged explaining how to install Caddy.
2. openclaw continues operating with the existing application-level `fetchWithSsrFGuard` protections.

To suppress the warning if you intentionally don't want the proxy:

```yaml
ssrfProxy:
  enabled: false
```

## Environment Variables

| Variable                       | Description                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `OPENCLAW_CADDY_BINARY`        | Override path to the caddy binary (alternative to `ssrfProxy.binaryPath`)                      |
| `OPENCLAW_SKIP_CADDY_DOWNLOAD` | Set to `1` to skip the postinstall Caddy download (CI, Docker, airgapped)                      |
| `OPENCLAW_NIX_MODE`            | Set to `1` when openclaw is managed by Nix; the postinstall download is skipped with a message |

## Security Notes

- The Caddy sidecar listens **only on the loopback interface** (`127.0.0.1`), not on any external network interface.
- Caddy's admin API is **disabled** — there is no management surface.
- The proxy does **not** log request contents — only warnings for blocked requests.
- Both the network-level (Caddy) and application-level (`fetchWithSsrFGuard`) protections are active simultaneously, providing defence-in-depth.
