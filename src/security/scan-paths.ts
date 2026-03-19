import fs from "node:fs";
import { isPathInside as isBoundaryPathInside } from "../infra/path-guards.js";

export function isPathInside(basePath: string, candidatePath: string): boolean {
  return isBoundaryPathInside(basePath, candidatePath);
}

function safeRealpathSync(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

export function isPathInsideWithRealpath(
  basePath: string,
  candidatePath: string,
  opts?: { requireRealpath?: boolean },
): boolean {
  if (!isPathInside(basePath, candidatePath)) {
    return false;
  }
  const baseReal = safeRealpathSync(basePath);
  const candidateReal = safeRealpathSync(candidatePath);
  if (!baseReal || !candidateReal) {
    return opts?.requireRealpath !== true;
  }
  return isPathInside(baseReal, candidateReal);
}

export function extensionUsesSkippedScannerPath(entry: string): boolean {
  const segments = entry.split(/[\\/]+/).filter(Boolean);
  return segments.some(
    (segment) =>
      segment === "node_modules" ||
      (segment.startsWith(".") && segment !== "." && segment !== ".."),
  );
}
