/**
 * Unit tests for `resolveCaddyBinaryPath`.
 *
 * The contract here is the binary resolution order baked into the SSRF
 * proxy: explicit config → env var → auto-downloaded `~/.openclaw/bin/caddy-ssrf`
 * → `caddy` on PATH. Each tier should beat every tier below it.
 *
 * The auto-download tier is exercised against a temp HOME so we never touch
 * the real `~/.openclaw/bin` of whoever is running the test.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { resolveCaddyBinaryPath } from "./proxy-process.js";

const ENV_KEY = "OPENCLAW_CADDY_BINARY";

describe("resolveCaddyBinaryPath", () => {
  let savedEnv: string | undefined;
  let homeDir: string;
  let homedirSpy: MockInstance | null = null;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    homeDir = mkdtempSync(join(tmpdir(), "openclaw-resolve-caddy-"));
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(homeDir);
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
    homedirSpy?.mockRestore();
    homedirSpy = null;
    rmSync(homeDir, { recursive: true, force: true });
  });

  function seedAutoDownloaded(executable: boolean): string {
    const binDir = join(homeDir, ".openclaw", "bin");
    mkdirSync(binDir, { recursive: true });
    const binaryName = process.platform === "win32" ? "caddy-ssrf.exe" : "caddy-ssrf";
    const binPath = join(binDir, binaryName);
    writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
    if (executable) {
      try {
        chmodSync(binPath, 0o755);
      } catch {
        // chmod is a no-op on Windows; resolution still works there.
      }
    } else {
      try {
        chmodSync(binPath, 0o644);
      } catch {
        // ignore
      }
    }
    return binPath;
  }

  it("explicit binaryPath wins over every other tier", () => {
    process.env[ENV_KEY] = "/from/env/caddy";
    const auto = seedAutoDownloaded(true);
    expect(resolveCaddyBinaryPath("/explicit/caddy")).toBe("/explicit/caddy");
    void auto;
  });

  it("env var wins over auto-download and PATH fallback", () => {
    process.env[ENV_KEY] = "/from/env/caddy";
    seedAutoDownloaded(true);
    expect(resolveCaddyBinaryPath()).toBe("/from/env/caddy");
  });

  it("auto-downloaded binary at ~/.openclaw/bin/caddy-ssrf is used when present + executable", () => {
    const expected = seedAutoDownloaded(true);
    expect(resolveCaddyBinaryPath()).toBe(expected);
  });

  it("falls back to system 'caddy' when no auto-downloaded binary exists", () => {
    expect(resolveCaddyBinaryPath()).toBe("caddy");
  });

  // POSIX-only: on Windows X_OK collapses to F_OK, so a non-executable file
  // would still be picked up. Our auto-download path always sets the execute
  // bit, so this gap is acceptable; we only assert the strict POSIX behaviour.
  it.runIf(process.platform !== "win32")(
    "skips a non-executable file at the auto-download path",
    () => {
      seedAutoDownloaded(false);
      expect(resolveCaddyBinaryPath()).toBe("caddy");
    },
  );

  it("trims whitespace around the env var value", () => {
    process.env[ENV_KEY] = "  /spaced/caddy  ";
    expect(resolveCaddyBinaryPath()).toBe("/spaced/caddy");
  });

  it("treats an empty/whitespace-only env var as unset", () => {
    process.env[ENV_KEY] = "   ";
    seedAutoDownloaded(true);
    // Should fall through to auto-download.
    expect(resolveCaddyBinaryPath()).not.toBe("   ");
  });
});
