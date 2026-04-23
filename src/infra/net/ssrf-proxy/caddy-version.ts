/**
 * Pinned Caddy version used for the SSRF forward proxy.
 *
 * This constant must be kept in sync with `scripts/caddy-ssrf-version.txt`,
 * which is the plain-text mirror consumed by shell scripts (install.sh) and
 * the `postinstall-ssrf-caddy.mjs` download script.
 *
 * Bumping this version requires a matching `caddy-ssrf-vX.Y.Z` GitHub release
 * with pre-built binaries and a `caddy-ssrf-X.Y.Z-checksums.txt` asset.
 */
export const CADDY_SSRF_VERSION = "2.11.1";
