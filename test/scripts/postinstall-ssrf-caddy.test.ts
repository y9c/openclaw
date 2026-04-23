/**
 * Unit tests for `scripts/postinstall-ssrf-caddy.mjs`.
 *
 * The postinstall script is the single place that decides whether a Caddy +
 * forwardproxy binary lands in `~/.openclaw/bin/caddy-ssrf` during
 * `npm install openclaw`. These tests pin the contract that matters for
 * `npm install` safety:
 *
 *  - Skip envs (`OPENCLAW_SKIP_CADDY_DOWNLOAD`, `OPENCLAW_NIX_MODE`) short-circuit
 *  - Unsupported (platform, arch) tuples are skipped, not errors
 *  - Cached versioned binaries are reused (idempotent)
 *  - Checksum mismatches delete the downloaded binary and warn
 *  - Network errors surface as warnings, never as a non-zero exit
 *  - Successful downloads chmod, symlink, and clean up older versions
 *
 * The script never touches the real network or the real `~/.openclaw`
 * directory under test — we drive `installCaddySsrFBinary` with a stub
 * `httpsModule`, a temp HOME dir, and a captured logger.
 */

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PLATFORM_MAP,
  buildAssetName,
  buildAssetUrl,
  buildChecksumsUrl,
  cleanOldVersions,
  computeCachePaths,
  ensureSymlink,
  installCaddySsrFBinary,
  parseChecksum,
  readPinnedCaddyVersion,
  resolvePlatformKey,
} from "../../scripts/postinstall-ssrf-caddy.mjs";

const VERSION = "2.11.1";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "openclaw-postinstall-caddy-"));
}

function writeVersionFile(dir: string, version = VERSION): string {
  const filePath = join(dir, "caddy-ssrf-version.txt");
  writeFileSync(filePath, `${version}\n`, "utf8");
  return filePath;
}

function silentLogger() {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * Minimal in-memory `https`-like module the script uses. We accept a map of
 * URL -> { status, body, headers } and a fallback for unknown URLs.
 */
type StubResponse = {
  status?: number;
  body?: Buffer | string;
  headers?: Record<string, string>;
  error?: Error;
};

function makeStubHttps(responses: Record<string, StubResponse>) {
  return {
    get(url: string, cb: (res: unknown) => void) {
      const emitter = new EventEmitter() as EventEmitter & {
        on: (event: string, listener: (...args: unknown[]) => void) => unknown;
      };
      // Defer error emission to next tick so callers can attach listeners.
      const stub = responses[url];
      if (!stub) {
        process.nextTick(() => emitter.emit("error", new Error(`Unstubbed URL: ${url}`)));
        return emitter;
      }
      if (stub.error) {
        process.nextTick(() => emitter.emit("error", stub.error));
        return emitter;
      }
      const status = stub.status ?? 200;
      const body = stub.body ?? Buffer.alloc(0);
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const res = Readable.from([buf]) as Readable & {
        statusCode?: number;
        headers?: Record<string, string>;
        setEncoding?: (enc: string) => void;
      };
      res.statusCode = status;
      res.headers = stub.headers ?? {};
      // The script calls setEncoding for the text helper; Readable.from doesn't
      // implement it, so install a no-op shim that uses Buffer-by-default.
      res.setEncoding = function setEncoding() {
        return undefined;
      };
      process.nextTick(() => cb(res));
      return emitter;
    },
  } as const;
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

const HOMES: string[] = [];
afterEach(() => {
  while (HOMES.length > 0) {
    const dir = HOMES.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function mkHome(): string {
  const dir = tempHome();
  HOMES.push(dir);
  return dir;
}

describe("postinstall-ssrf-caddy: pure helpers", () => {
  it("PLATFORM_MAP covers the documented (os, arch) matrix", () => {
    expect(PLATFORM_MAP.darwin?.arm64).toBe("darwin-arm64");
    expect(PLATFORM_MAP.darwin?.x64).toBe("darwin-x64");
    expect(PLATFORM_MAP.linux?.arm64).toBe("linux-arm64");
    expect(PLATFORM_MAP.linux?.x64).toBe("linux-x64");
    expect(PLATFORM_MAP.win32?.x64).toBe("windows-x64");
  });

  it("resolvePlatformKey returns null for unsupported tuples", () => {
    expect(resolvePlatformKey("linux", "x64")).toBe("linux-x64");
    expect(resolvePlatformKey("freebsd", "x64")).toBeNull();
    expect(resolvePlatformKey("win32", "arm64")).toBeNull();
    expect(resolvePlatformKey("darwin", "ia32")).toBeNull();
  });

  it("computeCachePaths produces .exe names on Windows and bare names elsewhere", () => {
    const linux = computeCachePaths({ homeDir: "/h", version: VERSION, platform: "linux" });
    expect(linux.targetPath).toBe(`/h/.openclaw/bin/caddy-ssrf`);
    expect(linux.versionedPath).toBe(`/h/.openclaw/bin/caddy-ssrf-${VERSION}`);

    const win = computeCachePaths({ homeDir: "C:\\Users\\x", version: VERSION, platform: "win32" });
    expect(win.targetPath.endsWith("caddy-ssrf.exe")).toBe(true);
    expect(win.versionedPath.endsWith(`caddy-ssrf-${VERSION}.exe`)).toBe(true);
  });

  it("buildAssetName / buildAssetUrl / buildChecksumsUrl agree on naming", () => {
    const assetName = buildAssetName({
      version: VERSION,
      platformKey: "linux-x64",
      platform: "linux",
    });
    expect(assetName).toBe(`caddy-ssrf-${VERSION}-linux-x64`);
    expect(buildAssetUrl({ version: VERSION, assetName })).toBe(
      `https://github.com/openclaw/openclaw/releases/download/caddy-ssrf-v${VERSION}/${assetName}`,
    );
    expect(buildChecksumsUrl({ version: VERSION })).toBe(
      `https://github.com/openclaw/openclaw/releases/download/caddy-ssrf-v${VERSION}/caddy-ssrf-${VERSION}-checksums.txt`,
    );

    const winAsset = buildAssetName({
      version: VERSION,
      platformKey: "windows-x64",
      platform: "win32",
    });
    expect(winAsset.endsWith(".exe")).toBe(true);
  });

  it("parseChecksum handles both `<hash>  <name>` and `<hash> *<name>` formats", () => {
    const body = [
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef  caddy-ssrf-2.11.1-linux-x64",
      "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface *caddy-ssrf-2.11.1-windows-x64.exe",
      "# a comment line",
      "",
    ].join("\n");
    expect(parseChecksum(body, "caddy-ssrf-2.11.1-linux-x64")).toBe(
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    );
    expect(parseChecksum(body, "caddy-ssrf-2.11.1-windows-x64.exe")).toBe(
      "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface",
    );
    expect(parseChecksum(body, "missing")).toBeNull();
  });

  it("readPinnedCaddyVersion rejects malformed version files", () => {
    const dir = mkHome();
    const goodFile = writeVersionFile(dir, "1.2.3");
    expect(readPinnedCaddyVersion(goodFile)).toBe("1.2.3");
    const bad = join(dir, "bad.txt");
    writeFileSync(bad, "not-a-version\n");
    expect(() => readPinnedCaddyVersion(bad)).toThrow(/invalid version/u);
  });

  it("cleanOldVersions removes only stale caddy-ssrf-* entries", () => {
    const dir = mkHome();
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, `caddy-ssrf-${VERSION}`), "current");
    writeFileSync(join(binDir, "caddy-ssrf-2.10.0"), "old");
    writeFileSync(join(binDir, "caddy-ssrf-2.9.0"), "older");
    writeFileSync(join(binDir, "unrelated.txt"), "leave-me");

    const removed = cleanOldVersions(binDir, VERSION);
    expect(removed.toSorted()).toEqual(["caddy-ssrf-2.10.0", "caddy-ssrf-2.9.0"]);
    const remaining = readdirSync(binDir).toSorted();
    expect(remaining).toEqual([`caddy-ssrf-${VERSION}`, "unrelated.txt"]);
  });

  it("ensureSymlink replaces an existing target", () => {
    const dir = mkHome();
    const target = join(dir, "real");
    const link = join(dir, "link");
    writeFileSync(target, "ok");
    writeFileSync(link, "stale");
    const mode = ensureSymlink(target, link);
    expect(mode === "symlink" || mode === "copy").toBe(true);
    // Whether symlinked or copied, reading via the link path returns the
    // target contents.
    expect(readFileSync(link, "utf8")).toBe("ok");
  });
});

describe("postinstall-ssrf-caddy: installCaddySsrFBinary", () => {
  let logger: ReturnType<typeof silentLogger>;
  let homeDir: string;
  let versionFilePath: string;

  beforeEach(() => {
    logger = silentLogger();
    homeDir = mkHome();
    versionFilePath = writeVersionFile(homeDir);
  });

  it("skips entirely when OPENCLAW_SKIP_CADDY_DOWNLOAD=1", async () => {
    const result = await installCaddySsrFBinary({
      homeDir,
      env: { OPENCLAW_SKIP_CADDY_DOWNLOAD: "1" },
      versionFilePath,
      logger,
      httpsModule: makeStubHttps({}),
    });
    expect(result.status).toBe("skipped-env");
    expect(logger.log).toHaveBeenCalled();
  });

  it("skips with a Nix-specific message when OPENCLAW_NIX_MODE=1", async () => {
    const result = await installCaddySsrFBinary({
      homeDir,
      env: { OPENCLAW_NIX_MODE: "1" },
      versionFilePath,
      logger,
      httpsModule: makeStubHttps({}),
    });
    expect(result.status).toBe("skipped-nix");
    expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/Nix mode/u));
  });

  it("skips unsupported platform/arch tuples without erroring", async () => {
    const result = await installCaddySsrFBinary({
      homeDir,
      platform: "freebsd",
      arch: "x64",
      env: {},
      versionFilePath,
      logger,
      httpsModule: makeStubHttps({}),
    });
    expect(result.status).toBe("skipped-platform");
  });

  it("returns 'cached' and refreshes the symlink when versioned binary exists", async () => {
    const platform = "linux";
    const { binDir, versionedPath, targetPath } = computeCachePaths({
      homeDir,
      version: VERSION,
      platform,
    });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(versionedPath, "binary");

    const result = await installCaddySsrFBinary({
      homeDir,
      platform,
      arch: "x64",
      env: {},
      versionFilePath,
      logger,
      httpsModule: makeStubHttps({}),
    });
    expect(result).toMatchObject({ status: "cached", version: VERSION, path: targetPath });
    // Symlink (or copy) was created at targetPath.
    expect(readFileSync(targetPath, "utf8")).toBe("binary");
  });

  it("downloads, verifies checksum, chmods, symlinks, and cleans up old versions", async () => {
    const platform = "linux";
    const platformKey = "linux-x64";
    const assetName = buildAssetName({ version: VERSION, platformKey, platform });
    const url = buildAssetUrl({ version: VERSION, assetName });
    const checksumsUrl = buildChecksumsUrl({ version: VERSION });
    const binaryBytes = Buffer.from("fake-caddy-binary");
    const expectedHash = sha256Hex(binaryBytes);
    const checksumsBody = `${expectedHash}  ${assetName}\n`;

    // Pre-seed an older versioned binary that should get cleaned up.
    const { binDir, targetPath } = computeCachePaths({ homeDir, version: VERSION, platform });
    mkdirSync(binDir, { recursive: true });
    const stale = join(binDir, "caddy-ssrf-2.0.0");
    writeFileSync(stale, "stale");

    const result = await installCaddySsrFBinary({
      homeDir,
      platform,
      arch: "x64",
      env: {},
      versionFilePath,
      logger,
      httpsModule: makeStubHttps({
        [url]: { body: binaryBytes },
        [checksumsUrl]: { body: checksumsBody },
      }),
    });

    expect(result).toMatchObject({ status: "downloaded", version: VERSION, path: targetPath });
    expect(readFileSync(targetPath, "utf8")).toBe("fake-caddy-binary");
    // Stale version is gone.
    expect(readdirSync(binDir).includes("caddy-ssrf-2.0.0")).toBe(false);
    // Current versioned binary remains.
    expect(readdirSync(binDir).includes(`caddy-ssrf-${VERSION}`)).toBe(true);
  });

  it("removes the binary and warns on checksum mismatch", async () => {
    const platform = "linux";
    const platformKey = "linux-x64";
    const assetName = buildAssetName({ version: VERSION, platformKey, platform });
    const url = buildAssetUrl({ version: VERSION, assetName });
    const checksumsUrl = buildChecksumsUrl({ version: VERSION });
    const checksumsBody = `${"a".repeat(64)}  ${assetName}\n`;

    const { binDir, versionedPath } = computeCachePaths({
      homeDir,
      version: VERSION,
      platform,
    });

    const result = await installCaddySsrFBinary({
      homeDir,
      platform,
      arch: "x64",
      env: {},
      versionFilePath,
      logger,
      httpsModule: makeStubHttps({
        [url]: { body: Buffer.from("does-not-match") },
        [checksumsUrl]: { body: checksumsBody },
      }),
    });

    expect(result.status).toBe("failed");
    expect(result).toMatchObject({ reason: "checksum-mismatch" });
    expect(logger.warn).toHaveBeenCalled();
    // Binary was deleted from cache.
    const present = (() => {
      try {
        readFileSync(versionedPath);
        return true;
      } catch {
        return false;
      }
    })();
    expect(present).toBe(false);
    void binDir;
  });

  it("warns and never throws on a network error", async () => {
    const platform = "linux";
    const platformKey = "linux-x64";
    const assetName = buildAssetName({ version: VERSION, platformKey, platform });
    const url = buildAssetUrl({ version: VERSION, assetName });

    const result = await installCaddySsrFBinary({
      homeDir,
      platform,
      arch: "x64",
      env: {},
      versionFilePath,
      logger,
      httpsModule: makeStubHttps({
        [url]: { error: new Error("offline") },
      }),
    });

    expect(result).toMatchObject({ status: "failed", reason: "download" });
    expect(logger.warn).toHaveBeenCalled();
  });

  it("refuses to install when the checksums file is missing the asset entry", async () => {
    const platform = "linux";
    const platformKey = "linux-x64";
    const assetName = buildAssetName({ version: VERSION, platformKey, platform });
    const url = buildAssetUrl({ version: VERSION, assetName });
    const checksumsUrl = buildChecksumsUrl({ version: VERSION });

    const result = await installCaddySsrFBinary({
      homeDir,
      platform,
      arch: "x64",
      env: {},
      versionFilePath,
      logger,
      httpsModule: makeStubHttps({
        [url]: { body: Buffer.from("payload") },
        [checksumsUrl]: { body: "# nothing here\n" },
      }),
    });

    expect(result).toMatchObject({ status: "failed", reason: "checksum-missing" });
  });
});
