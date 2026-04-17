import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { redactMessages } from "./hook-redaction.js";

describe("redactMessages", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openclaw-redact-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function sessionFile() {
    return join(tempDir, "transcript.jsonl");
  }

  async function writeTranscript(messages: Array<Record<string, unknown>>) {
    const content = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await writeFile(sessionFile(), content, "utf-8");
  }

  async function readTranscript(): Promise<Array<Record<string, unknown>>> {
    const content = await readFile(sessionFile(), "utf-8");
    return content
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  const audit = {
    reason: "test",
    hookPoint: "llm_output",
    pluginId: "test-plugin",
    timestamp: Date.now(),
  };

  describe("filter by indices", () => {
    it("removes a single message by index", async () => {
      await writeTranscript([
        { role: "user", content: "hello" },
        { role: "assistant", content: "bad stuff" },
        { role: "user", content: "thanks" },
      ]);

      const removed = await redactMessages(sessionFile(), { indices: [1] }, audit);

      expect(removed).toBe(1);
      const remaining = await readTranscript();
      expect(remaining).toHaveLength(2);
      expect(remaining[0]).toEqual({ role: "user", content: "hello" });
      expect(remaining[1]).toEqual({ role: "user", content: "thanks" });
    });

    it("removes multiple messages by indices", async () => {
      await writeTranscript([
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
        { role: "assistant", content: "d" },
      ]);

      const removed = await redactMessages(sessionFile(), { indices: [1, 3] }, audit);

      expect(removed).toBe(2);
      const remaining = await readTranscript();
      expect(remaining).toHaveLength(2);
      expect(remaining.map((m) => m.content)).toEqual(["a", "c"]);
    });

    it("ignores out-of-bounds indices", async () => {
      await writeTranscript([{ role: "user", content: "hello" }]);

      const removed = await redactMessages(sessionFile(), { indices: [5, -1] }, audit);
      expect(removed).toBe(0);
    });
  });

  describe("filter by runId", () => {
    it("removes messages matching runId", async () => {
      await writeTranscript([
        { role: "user", content: "a", runId: "run-1" },
        { role: "assistant", content: "b", runId: "run-1" },
        { role: "user", content: "c", runId: "run-2" },
      ]);

      const removed = await redactMessages(sessionFile(), { runId: "run-1" }, audit);

      expect(removed).toBe(2);
      const remaining = await readTranscript();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toEqual({ role: "user", content: "c", runId: "run-2" });
    });
  });

  describe("filter by match", () => {
    it("removes messages matching role", async () => {
      await writeTranscript([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "bye" },
      ]);

      const removed = await redactMessages(sessionFile(), { match: { role: "assistant" } }, audit);

      expect(removed).toBe(1);
      const remaining = await readTranscript();
      expect(remaining).toHaveLength(2);
    });

    it("removes messages matching role and content substring", async () => {
      await writeTranscript([
        { role: "assistant", content: "safe response" },
        { role: "assistant", content: "bad content here" },
        { role: "assistant", content: "another safe one" },
      ]);

      const removed = await redactMessages(
        sessionFile(),
        { match: { role: "assistant", contentSubstring: "bad content" } },
        audit,
      );

      expect(removed).toBe(1);
      const remaining = await readTranscript();
      expect(remaining).toHaveLength(2);
      expect(remaining.map((m) => m.content)).toEqual(["safe response", "another safe one"]);
    });
  });

  describe("idempotency", () => {
    it("returns 0 when nothing matches", async () => {
      await writeTranscript([{ role: "user", content: "hello" }]);

      const removed = await redactMessages(sessionFile(), { match: { role: "tool" } }, audit);
      expect(removed).toBe(0);
    });

    it("returns 0 for missing file (archived session)", async () => {
      const removed = await redactMessages(
        join(tempDir, "nonexistent.jsonl"),
        { indices: [0] },
        audit,
      );
      expect(removed).toBe(0);
    });
  });

  describe("audit log", () => {
    it("writes audit entry to redaction-log.jsonl", async () => {
      await writeTranscript([
        { role: "user", content: "hello" },
        { role: "assistant", content: "bad" },
      ]);

      await redactMessages(
        sessionFile(),
        { indices: [1] },
        {
          reason: "policy_violation",
          category: "violence",
          hookPoint: "llm_output",
          pluginId: "moderation",
          timestamp: 1713340800,
        },
      );

      const auditFile = join(tempDir, "redaction-log.jsonl");
      const auditContent = await readFile(auditFile, "utf-8");
      const entry = JSON.parse(auditContent.trim());

      expect(entry.ts).toBe(1713340800);
      expect(entry.hookPoint).toBe("llm_output");
      expect(entry.pluginId).toBe("moderation");
      expect(entry.reason).toBe("policy_violation");
      expect(entry.category).toBe("violence");
      expect(entry.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(entry.messagesRemoved).toBe(1);
    });

    it("appends to existing audit log", async () => {
      await writeTranscript([
        { role: "assistant", content: "bad1" },
        { role: "assistant", content: "bad2" },
      ]);

      await redactMessages(sessionFile(), { indices: [0] }, audit);

      // Re-create transcript for second redaction
      await writeTranscript([{ role: "assistant", content: "bad2" }]);
      await redactMessages(sessionFile(), { indices: [0] }, audit);

      const auditFile = join(tempDir, "redaction-log.jsonl");
      const auditContent = await readFile(auditFile, "utf-8");
      const entries = auditContent
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));

      expect(entries).toHaveLength(2);
    });
  });

  describe("combined filters", () => {
    it("combines indices + match filters", async () => {
      await writeTranscript([
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
        { role: "assistant", content: "target" },
      ]);

      const removed = await redactMessages(
        sessionFile(),
        { indices: [0], match: { role: "assistant", contentSubstring: "target" } },
        audit,
      );

      expect(removed).toBe(2);
      const remaining = await readTranscript();
      expect(remaining).toHaveLength(2);
      expect(remaining.map((m) => m.content)).toEqual(["b", "c"]);
    });
  });
});
