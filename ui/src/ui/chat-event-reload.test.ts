import { describe, expect, it } from "vitest";
import { shouldReloadHistoryForFinalEvent } from "./chat-event-reload.ts";

describe("shouldReloadHistoryForFinalEvent", () => {
  it("returns false for non-final events", () => {
    expect(
      shouldReloadHistoryForFinalEvent({
        runId: "run-1",
        sessionKey: "main",
        state: "delta",
        message: { role: "assistant", content: [{ type: "text", text: "x" }] },
      }),
    ).toBe(false);
  });

  it("returns true when final event has no message payload", () => {
    expect(
      shouldReloadHistoryForFinalEvent({
        runId: "run-1",
        sessionKey: "main",
        state: "final",
      }),
    ).toBe(true);
  });

  it("returns true when final event includes assistant payload", () => {
    expect(
      shouldReloadHistoryForFinalEvent({
        runId: "run-1",
        sessionKey: "main",
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }),
    ).toBe(true);
  });

  it("returns true when final event message role is non-assistant", () => {
    expect(
      shouldReloadHistoryForFinalEvent({
        runId: "run-1",
        sessionKey: "main",
        state: "final",
        message: { role: "user", content: [{ type: "text", text: "echo" }] },
      }),
    ).toBe(true);
  });

  it("returns true when state is `error` (hook-block path persists policy reply on disk)", () => {
    // Regression: hook-block on llm_output emits `state: "error"` (errorKind="hook_block")
    // and the runner persists the policy replacement message. The SPA must
    // refetch chat.history so the assistant bubble shows the block warning
    // instead of the streamed (now-redacted) text or an empty bubble.
    expect(
      shouldReloadHistoryForFinalEvent({
        runId: "run-1",
        sessionKey: "main",
        state: "error",
        errorKind: "hook_block",
        errorMessage: "🔒 [hook-echo] blocked by policy",
      } as Parameters<typeof shouldReloadHistoryForFinalEvent>[0]),
    ).toBe(true);
  });
});
