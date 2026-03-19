import { afterEach, describe, expect, it, vi } from "vitest";

const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value,
  });
}

afterEach(() => {
  setPlatform(originalPlatform);
  vi.restoreAllMocks();
});

describe("security scan path guards", () => {
  it("uses Windows-aware containment checks for differently normalized paths", async () => {
    setPlatform("win32");
    const { isPathInside } = await import("./scan-paths.js");

    expect(
      isPathInside(String.raw`C:\Workspace\Root`, String.raw`c:\workspace\root\hooks\hook`),
    ).toBe(true);
    expect(
      isPathInside(String.raw`\\?\C:\Workspace\Root`, String.raw`C:\workspace\root\hooks\hook`),
    ).toBe(true);
  });
});
