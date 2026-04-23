#!/usr/bin/env node
/**
 * postinstall-ssrf-caddy.mjs
 *
 * Downloads a pre-built Caddy + forwardproxy binary into ~/.openclaw/bin/ so
 * the openclaw network-level SSRF proxy works out of the box.
 *
 * Hard requirements (see ssrf-proxy-bundled-caddy-spec.md):
 *  - Failure-tolerant: never block `npm install`. Network errors, checksum
 *    mismatches, and unsupported platforms exit 0 with a warning.
 *  - Idempotent: cached versioned binaries are reused.
 *  - Skippable: respects OPENCLAW_SKIP_CADDY_DOWNLOAD=1 and OPENCLAW_NIX_MODE=1.
 *  - Checksum-verified: SHA-256 hashes are validated against the release-side
 *    checksums file. Mismatched binaries are removed.
 *
 * Exposed exports allow `scripts/postinstall-ssrf-caddy.test.mjs` to drive the
 * logic with stub fetchers and a temp HOME so the script never touches the
 * real network or the real ~/.openclaw directory under test.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Maps Node's process.platform / process.arch into the asset suffix used by
 * the `caddy-ssrf-vX.Y.Z` GitHub release. Keep in sync with
 * `.github/workflows/build-caddy-ssrf.yml`.
 */
export const PLATFORM_MAP = Object.freeze({
  darwin: { arm64: "darwin-arm64", x64: "darwin-x64" },
  linux: { arm64: "linux-arm64", x64: "linux-x64" },
  win32: { x64: "windows-x64" },
});

/**
 * Reads the pinned Caddy version from `scripts/caddy-ssrf-version.txt`.
 * The text file is the single source of truth shared with shell scripts.
 */
export function readPinnedCaddyVersion(
  versionFilePath = join(__dirname, "caddy-ssrf-version.txt"),
) {
  const raw = fs.readFileSync(versionFilePath, "utf8");
  const trimmed = raw.trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(trimmed)) {
    throw new Error(`postinstall-ssrf-caddy: invalid version in ${versionFilePath}: ${trimmed}`);
  }
  return trimmed;
}

/**
 * Returns the platform-key portion of an asset name (e.g. "darwin-arm64") or
 * null when the current platform/arch combo is not pre-built.
 */
export function resolvePlatformKey(platform = process.platform, arch = process.arch) {
  const archMap = PLATFORM_MAP[platform];
  if (!archMap) {
    return null;
  }
  return archMap[arch] ?? null;
}

/**
 * Computes the cache layout for a given home dir + version.
 * Pure function — easy to unit-test.
 */
export function computeCachePaths({ homeDir, version, platform = process.platform } = {}) {
  if (!homeDir) {
    throw new Error("computeCachePaths: homeDir is required");
  }
  if (!version) {
    throw new Error("computeCachePaths: version is required");
  }
  const isWindows = platform === "win32";
  const binDir = join(homeDir, ".openclaw", "bin");
  const targetName = isWindows ? "caddy-ssrf.exe" : "caddy-ssrf";
  const versionedName = isWindows ? `caddy-ssrf-${version}.exe` : `caddy-ssrf-${version}`;
  return {
    binDir,
    targetPath: join(binDir, targetName),
    versionedPath: join(binDir, versionedName),
    versionedName,
  };
}

/**
 * Builds the asset name as published in the GitHub release.
 */
export function buildAssetName({ version, platformKey, platform = process.platform }) {
  const ext = platform === "win32" ? ".exe" : "";
  return `caddy-ssrf-${version}-${platformKey}${ext}`;
}

/**
 * Builds the GitHub release download URL for the given asset.
 */
export function buildAssetUrl({ version, assetName }) {
  return `https://github.com/openclaw/openclaw/releases/download/caddy-ssrf-v${version}/${assetName}`;
}

/**
 * Builds the GitHub release URL for the per-version checksums file.
 */
export function buildChecksumsUrl({ version }) {
  return `https://github.com/openclaw/openclaw/releases/download/caddy-ssrf-v${version}/caddy-ssrf-${version}-checksums.txt`;
}

/**
 * Downloads a URL to disk via streaming, following up to 5 redirects.
 * Resolves on success; rejects with an Error on any failure (including non-200
 * responses). Replaceable in tests via the `httpsModule` parameter.
 */
export function downloadFile(url, destPath, { httpsModule = https, redirectsLeft = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsModule.get(url, (res) => {
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const next = res.headers?.location;
        res.resume();
        if (!next || redirectsLeft <= 0) {
          reject(new Error(`Too many redirects fetching ${url}`));
          return;
        }
        downloadFile(next, destPath, { httpsModule, redirectsLeft: redirectsLeft - 1 }).then(
          resolve,
          reject,
        );
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`HTTP ${status} fetching ${url}`));
        return;
      }
      const out = fs.createWriteStream(destPath);
      res.pipe(out);
      out.on("error", reject);
      out.on("finish", () => out.close((err) => (err ? reject(err) : resolve())));
    });
    request.on("error", reject);
  });
}

/**
 * Fetches a URL into memory as a UTF-8 string. Used for the small
 * checksums.txt file. Rejects on any non-2xx response.
 */
export function fetchText(url, { httpsModule = https, redirectsLeft = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsModule.get(url, (res) => {
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const next = res.headers?.location;
        res.resume();
        if (!next || redirectsLeft <= 0) {
          reject(new Error(`Too many redirects fetching ${url}`));
          return;
        }
        fetchText(next, { httpsModule, redirectsLeft: redirectsLeft - 1 }).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`HTTP ${status} fetching ${url}`));
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve(body));
      res.on("error", reject);
    });
    request.on("error", reject);
  });
}

/**
 * Computes a file's SHA-256 hex digest by streaming.
 */
export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Parses a `sha256sum`-style checksums file body and returns the expected hex
 * digest for `assetName`, or null if the asset is absent.
 *
 * Accepts both `<hex>  <name>` (two spaces) and `<hex> *<name>` (binary mode).
 */
export function parseChecksum(body, assetName) {
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/u.exec(line);
    if (!match) {
      continue;
    }
    const hash = match[1].toLowerCase();
    const name = match[2].trim();
    if (name === assetName) {
      return hash;
    }
  }
  return null;
}

/**
 * Replaces (or creates) a symlink at `linkPath` pointing to `targetPath`.
 * Falls back to copying the file on platforms where symlinking is not allowed
 * (typically Windows without developer mode).
 */
export function ensureSymlink(targetPath, linkPath) {
  try {
    if (fs.existsSync(linkPath) || fs.lstatSync(linkPath, { throwIfNoEntry: false })) {
      try {
        fs.unlinkSync(linkPath);
      } catch {
        // ignore — overwritten below
      }
    }
  } catch {
    // ignore — link did not exist
  }
  try {
    fs.symlinkSync(targetPath, linkPath);
    return "symlink";
  } catch (err) {
    // EPERM/EEXIST on Windows etc. — fall back to a plain copy.
    try {
      fs.copyFileSync(targetPath, linkPath);
      try {
        fs.chmodSync(linkPath, 0o755);
      } catch {
        // chmod is a best-effort fix on POSIX; ignored on Windows.
      }
      return "copy";
    } catch (copyErr) {
      throw new Error(
        `ensureSymlink: failed to link or copy ${targetPath} -> ${linkPath}: ${String(err)} / ${String(copyErr)}`,
        { cause: copyErr },
      );
    }
  }
}

/**
 * Removes any cached `caddy-ssrf-*` binaries in `binDir` that are not the
 * current versioned binary. Safe even when `binDir` is missing.
 */
export function cleanOldVersions(binDir, currentVersion) {
  let entries;
  try {
    entries = fs.readdirSync(binDir);
  } catch {
    return [];
  }
  const removed = [];
  const currentSuffix = `caddy-ssrf-${currentVersion}`;
  for (const entry of entries) {
    if (!entry.startsWith("caddy-ssrf-")) {
      continue;
    }
    if (entry === currentSuffix || entry === `${currentSuffix}.exe`) {
      continue;
    }
    const full = join(binDir, entry);
    try {
      const st = fs.lstatSync(full);
      if (st.isDirectory()) {
        continue;
      }
      fs.unlinkSync(full);
      removed.push(entry);
    } catch {
      // best-effort cleanup; ignore failures
    }
  }
  return removed;
}

/**
 * Core install routine. Returns a structured result so tests and the CLI
 * recovery command can introspect what happened without parsing logs.
 *
 * Result `status` values:
 *  - "skipped-env"        OPENCLAW_SKIP_CADDY_DOWNLOAD=1
 *  - "skipped-nix"        OPENCLAW_NIX_MODE=1
 *  - "skipped-platform"   no pre-built binary for this platform/arch
 *  - "cached"             the versioned binary already existed
 *  - "downloaded"         freshly downloaded + verified
 *  - "failed"             download or verification failed (warning logged)
 */
export async function installCaddySsrFBinary({
  homeDir = os.homedir(),
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  versionFilePath,
  httpsModule,
  logger = console,
} = {}) {
  if (env["OPENCLAW_SKIP_CADDY_DOWNLOAD"] === "1") {
    logger.log?.("ssrf-proxy: OPENCLAW_SKIP_CADDY_DOWNLOAD=1 — skipping Caddy binary download");
    return { status: "skipped-env" };
  }
  if (env["OPENCLAW_NIX_MODE"] === "1") {
    logger.log?.(
      "ssrf-proxy: Nix mode — skipping Caddy download (manage the binary via your Nix config)",
    );
    return { status: "skipped-nix" };
  }

  const platformKey = resolvePlatformKey(platform, arch);
  if (!platformKey) {
    logger.log?.(`ssrf-proxy: no pre-built Caddy binary for ${platform}/${arch} — skipping`);
    return { status: "skipped-platform", platform, arch };
  }

  let version;
  try {
    version = readPinnedCaddyVersion(versionFilePath);
  } catch (err) {
    logger.warn?.(`ssrf-proxy: could not read pinned Caddy version: ${String(err)}`);
    return { status: "failed", reason: "version-file" };
  }

  const { binDir, targetPath, versionedPath } = computeCachePaths({
    homeDir,
    version,
    platform,
  });

  // Already cached?
  if (fs.existsSync(versionedPath)) {
    try {
      ensureSymlink(versionedPath, targetPath);
      cleanOldVersions(binDir, version);
    } catch (err) {
      logger.warn?.(`ssrf-proxy: failed to refresh cached Caddy symlink: ${String(err)}`);
    }
    return { status: "cached", version, path: targetPath };
  }

  fs.mkdirSync(binDir, { recursive: true });

  const assetName = buildAssetName({ version, platformKey, platform });
  const url = buildAssetUrl({ version, assetName });
  const checksumsUrl = buildChecksumsUrl({ version });

  logger.log?.(`ssrf-proxy: downloading Caddy ${version} for ${platformKey}...`);

  try {
    await downloadFile(url, versionedPath, { httpsModule });
  } catch (err) {
    safeUnlink(versionedPath);
    logger.warn?.(`ssrf-proxy: failed to download Caddy — ${describeError(err)}`);
    logger.warn?.("ssrf-proxy: SSRF network proxy will be unavailable until Caddy is installed.");
    logger.warn?.(
      "ssrf-proxy: See https://docs.openclaw.ai/security/ssrf-proxy for manual install.",
    );
    return { status: "failed", reason: "download" };
  }

  // Verify checksum. A failure to even fetch the checksums file is treated as
  // a verification failure — we never silently accept an unverified binary.
  let checksumsBody;
  try {
    checksumsBody = await fetchText(checksumsUrl, { httpsModule });
  } catch (err) {
    safeUnlink(versionedPath);
    logger.warn?.(
      `ssrf-proxy: could not fetch Caddy checksums (${describeError(err)}) — refusing to install unverified binary`,
    );
    return { status: "failed", reason: "checksum-fetch" };
  }

  const expected = parseChecksum(checksumsBody, assetName);
  if (!expected) {
    safeUnlink(versionedPath);
    logger.warn?.(
      `ssrf-proxy: checksums file did not contain an entry for ${assetName} — refusing to install unverified binary`,
    );
    return { status: "failed", reason: "checksum-missing" };
  }

  let actual;
  try {
    actual = await sha256File(versionedPath);
  } catch (err) {
    safeUnlink(versionedPath);
    logger.warn?.(`ssrf-proxy: could not hash downloaded Caddy binary: ${describeError(err)}`);
    return { status: "failed", reason: "hash" };
  }

  if (actual !== expected) {
    safeUnlink(versionedPath);
    logger.warn?.(
      `ssrf-proxy: Caddy checksum mismatch (expected ${expected}, got ${String(actual)}) — removing binary`,
    );
    return { status: "failed", reason: "checksum-mismatch", expected, actual };
  }

  try {
    fs.chmodSync(versionedPath, 0o755);
  } catch {
    // chmod is a no-op on Windows; ignore failures elsewhere too.
  }

  try {
    ensureSymlink(versionedPath, targetPath);
  } catch (err) {
    logger.warn?.(`ssrf-proxy: failed to link Caddy binary into ~/.openclaw/bin: ${String(err)}`);
    return { status: "failed", reason: "symlink" };
  }

  cleanOldVersions(binDir, version);

  logger.log?.(`ssrf-proxy: Caddy ${version} ready at ${targetPath}`);
  return { status: "downloaded", version, path: targetPath };
}

function safeUnlink(path) {
  try {
    fs.unlinkSync(path);
  } catch {
    // ignore — file may not exist
  }
}

function describeError(err) {
  if (err && typeof err === "object" && "message" in err) {
    return String(err.message);
  }
  return String(err);
}

/**
 * Top-level entrypoint. Always resolves with exit code 0 on user-visible
 * errors so npm install never fails because of this script.
 */
export async function main(argv = process.argv) {
  void argv;
  try {
    await installCaddySsrFBinary();
  } catch (err) {
    // Last-ditch safety net — should not fire because installCaddySsrFBinary
    // catches its own failures, but we never want to abort `npm install`.
    console.warn(`ssrf-proxy: postinstall encountered an unexpected error: ${describeError(err)}`);
  }
}

const isDirectInvocation = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  void main();
}
