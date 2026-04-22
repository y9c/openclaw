import crypto from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn(async (_request: unknown) => ({ messages: [] as Array<unknown> }));
const loadConfigMock = vi.fn(() => ({ session: { mainKey: "main", scope: "per-sender" } }));
const loadSessionStoreMock = vi.fn((_storePath: string) => ({}));
const resolveAgentIdFromSessionKeyMock = vi.fn((sessionKey: string) => {
  return sessionKey.match(/^agent:([^:]+)/)?.[1] ?? "main";
});
const resolveStorePathMock = vi.fn((_store: unknown, _options: unknown) => "/tmp/sessions.json");
const readLatestAssistantReplyMock = vi.fn(async (_params?: unknown) => undefined);

vi.mock("./subagent-announce.runtime.js", () => ({
  callGateway: (request: unknown) => callGatewayMock(request),
  loadConfig: () => loadConfigMock(),
  loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
  resolveAgentIdFromSessionKey: (sessionKey: string) =>
    resolveAgentIdFromSessionKeyMock(sessionKey),
  resolveStorePath: (store: unknown, options: unknown) => resolveStorePathMock(store, options),
}));

vi.mock("./tools/agent-step.js", () => ({
  readLatestAssistantReply: (params?: unknown) => readLatestAssistantReplyMock(params),
}));

import {
  __testing as subagentAnnounceOutputTesting,
  captureSubagentCompletionReply,
} from "./subagent-announce-output.js";

describe("captureSubagentCompletionReply live-first ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subagentAnnounceOutputTesting.setDepsForTest();
    callGatewayMock.mockImplementation(async (_request: unknown) => ({
      messages: [] as Array<unknown>,
    }));
    loadConfigMock.mockImplementation(() => ({
      session: { mainKey: "main", scope: "per-sender" },
    }));
    loadSessionStoreMock.mockImplementation(() => ({}));
    resolveAgentIdFromSessionKeyMock.mockImplementation((sessionKey: string) => {
      return sessionKey.match(/^agent:([^:]+)/)?.[1] ?? "main";
    });
    resolveStorePathMock.mockImplementation(() => "/tmp/sessions.json");
    readLatestAssistantReplyMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    subagentAnnounceOutputTesting.setDepsForTest();
  });

  it.each([
    {
      name: "an older transcript reply",
      staleTranscriptText: "old completion from previous run",
      currentLiveText: "fresh completion from current run",
    },
    {
      name: "an older ANNOUNCE_SKIP marker",
      staleTranscriptText: "ANNOUNCE_SKIP",
      currentLiveText: "fresh completion from current run",
    },
  ])("prefers live history over %s when reusing a child session key", async (scenario) => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "subagent-capture-"));
    const sessionId = crypto.randomUUID();
    const sessionKey = "agent:main:subagent:reused";
    const storePath = path.join(tmpDir, "sessions.json");
    const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);

    try {
      resolveStorePathMock.mockImplementation(() => storePath);
      loadSessionStoreMock.mockImplementation(() => ({
        [sessionKey]: {
          sessionId,
          sessionFile,
        },
      }));
      await writeFile(
        sessionFile,
        `${JSON.stringify({
          type: "message",
          id: "assistant-old",
          message: {
            role: "assistant",
            content: [{ type: "text", text: scenario.staleTranscriptText }],
          },
        })}\n`,
        "utf8",
      );
      callGatewayMock.mockImplementation(async (request: unknown) => {
        const typed = request as { method?: string };
        if (typed.method === "chat.history") {
          return {
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: scenario.currentLiveText }],
              },
            ] as Array<unknown>,
          };
        }
        return { messages: [] as Array<unknown> };
      });

      const reply = await captureSubagentCompletionReply(sessionKey, {
        waitForReply: true,
      });

      expect(reply).toBe(scenario.currentLiveText);
      expect(callGatewayMock).toHaveBeenCalledWith({
        method: "chat.history",
        params: { sessionKey, limit: 100 },
      });
      expect(readLatestAssistantReplyMock).not.toHaveBeenCalled();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
