/**
 * Hook Redaction API — Milestone 4
 *
 * Provides the `redactMessages()` function for hard-deleting messages
 * from session transcripts. This is a general-purpose core capability —
 * any plugin can call it for any reason (moderation, PII scrubbing,
 * user request, compliance, etc.).
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, rename, appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { RedactionAuditEntry } from "./hook-decision-types.js";

// ---------------------------------------------------------------------------
// Message filter for identifying messages to redact
// ---------------------------------------------------------------------------

export type RedactMessageFilter = {
  /** Remove messages by their index in the transcript. */
  indices?: number[];
  /** Remove messages by run ID. */
  runId?: string;
  /** Remove messages by role + content match. */
  match?: {
    role: "user" | "assistant" | "tool";
    contentSubstring?: string;
  };
};

export type RedactMessageAuditInput = {
  reason: string;
  category?: string;
  hookPoint: string;
  pluginId: string;
  timestamp: number;
};

// ---------------------------------------------------------------------------
// Core redaction function
// ---------------------------------------------------------------------------

/**
 * Hard-delete messages from a session transcript JSONL file.
 * Rewrites the JSONL file with the target message(s) removed.
 *
 * Strategy:
 * 1. Read the full transcript file into memory
 * 2. Filter out the target messages
 * 3. Write the filtered content to a temp file in the same directory
 * 4. Atomic rename to replace the original
 * 5. Append the audit entry to `<session-dir>/redaction-log.jsonl`
 *
 * @returns Number of messages removed.
 */
export async function redactMessages(
  sessionFile: string,
  filter: RedactMessageFilter,
  audit: RedactMessageAuditInput,
): Promise<number> {
  let rawContent: string;
  try {
    rawContent = await readFile(sessionFile, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // File not found (session archived or already gone). No-op.
      return 0;
    }
    throw err;
  }

  const lines = rawContent.split("\n").filter((line) => line.trim().length > 0);

  // Parse each line as JSON, keeping the raw line paired with parsed content
  const entries: Array<{ raw: string; parsed: Record<string, unknown>; index: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      entries.push({
        raw: lines[i],
        parsed: JSON.parse(lines[i]) as Record<string, unknown>,
        index: i,
      });
    } catch {
      // Keep unparseable lines as-is (don't lose data)
      entries.push({ raw: lines[i], parsed: {}, index: i });
    }
  }

  // Build the set of indices to remove
  const indicesToRemove = new Set<number>();

  if (filter.indices) {
    for (const idx of filter.indices) {
      if (idx >= 0 && idx < entries.length) {
        indicesToRemove.add(idx);
      }
    }
  }

  if (filter.runId) {
    for (const entry of entries) {
      if (entry.parsed.runId === filter.runId) {
        indicesToRemove.add(entry.index);
      }
    }
  }

  if (filter.match) {
    for (const entry of entries) {
      if (entry.parsed.role !== filter.match.role) {
        continue;
      }
      if (filter.match.contentSubstring) {
        const content = typeof entry.parsed.content === "string" ? entry.parsed.content : "";
        if (!content.includes(filter.match.contentSubstring)) {
          continue;
        }
      }
      indicesToRemove.add(entry.index);
    }
  }

  if (indicesToRemove.size === 0) {
    return 0; // Nothing to redact — idempotent
  }

  // Collect content hashes of removed messages for audit
  const removedContentParts: string[] = [];
  for (const idx of indicesToRemove) {
    const entry = entries[idx];
    if (entry) {
      removedContentParts.push(entry.raw);
    }
  }
  const contentHash = createHash("sha256").update(removedContentParts.join("\n")).digest("hex");

  // Filter out removed entries
  const keptLines = entries
    .filter((entry) => !indicesToRemove.has(entry.index))
    .map((entry) => entry.raw);

  // Atomic rewrite: write to temp file, then rename
  const tempFile = `${sessionFile}.redact-tmp-${Date.now()}`;
  const newContent = keptLines.length > 0 ? keptLines.join("\n") + "\n" : "";

  // Retry with backoff (3 attempts)
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(tempFile, newContent, "utf-8");
      await rename(tempFile, sessionFile);
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err;
      const delay = 100 * Math.pow(2, attempt); // 100ms, 200ms, 400ms
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  if (lastError) {
    // Don't corrupt the original file — leave temp in place
    throw new Error(
      `redactMessages: failed to atomically rewrite ${sessionFile} after 3 attempts`,
      {
        cause: lastError,
      },
    );
  }

  // Write audit entry (best-effort — redaction still succeeds if audit fails)
  try {
    const auditEntry: RedactionAuditEntry = {
      ts: audit.timestamp,
      hookPoint: audit.hookPoint,
      pluginId: audit.pluginId,
      reason: audit.reason,
      category: audit.category,
      contentHash: `sha256:${contentHash}`,
      messagesRemoved: indicesToRemove.size,
    };

    const auditFile = join(dirname(sessionFile), "redaction-log.jsonl");
    await mkdir(dirname(auditFile), { recursive: true });
    await appendFile(auditFile, JSON.stringify(auditEntry) + "\n", "utf-8");
  } catch {
    // Audit is best-effort. Redaction already succeeded.
  }

  return indicesToRemove.size;
}
