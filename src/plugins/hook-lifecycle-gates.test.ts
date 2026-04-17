import { describe, expect, it } from "vitest";
import type { GlobalHookRunnerRegistry } from "./hook-registry.types.js";
import type { PluginHookRegistration, PluginHookAgentContext } from "./hook-types.js";
import { createHookRunner } from "./hooks.js";

function makeRegistry(hooks: PluginHookRegistration[] = []): GlobalHookRunnerRegistry {
  return {
    hooks: [],
    typedHooks: hooks,
    plugins: [],
  };
}

const ctx: PluginHookAgentContext = {
  runId: "run-1",
  agentId: "agent-1",
  sessionKey: "session-1",
  sessionId: "sid-1",
};

describe("before_agent_run hook", () => {
  it("returns undefined when no handlers registered", async () => {
    const runner = createHookRunner(makeRegistry());
    const result = await runner.runBeforeAgentRun({ prompt: "hello", messages: [] }, ctx);
    expect(result).toBeUndefined();
  });

  it("returns pass when handler returns pass", async () => {
    const registry = makeRegistry([
      {
        pluginId: "test",
        hookName: "before_agent_run",
        handler: async () => ({ outcome: "pass" as const }),
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentRun({ prompt: "hello", messages: [] }, ctx);
    expect(result).toEqual({ outcome: "pass" });
  });

  it("returns block when handler returns block", async () => {
    const registry = makeRegistry([
      {
        pluginId: "test",
        hookName: "before_agent_run",
        handler: async () => ({
          outcome: "block" as const,
          reason: "unsafe content",
          userMessage: "I can't process that.",
          category: "violence",
        }),
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentRun({ prompt: "bad stuff", messages: [] }, ctx);
    expect(result?.outcome).toBe("block");
    if (result?.outcome === "block") {
      expect(result.reason).toBe("unsafe content");
      expect(result.userMessage).toBe("I can't process that.");
    }
  });

  it("merges with most-restrictive-wins: block beats pass", async () => {
    const registry = makeRegistry([
      {
        pluginId: "plugin-a",
        hookName: "before_agent_run",
        handler: async () => ({ outcome: "pass" as const }),
        source: "test",
        priority: 10,
      },
      {
        pluginId: "plugin-b",
        hookName: "before_agent_run",
        handler: async () => ({
          outcome: "block" as const,
          reason: "blocked",
        }),
        source: "test",
        priority: 5,
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentRun({ prompt: "test", messages: [] }, ctx);
    expect(result?.outcome).toBe("block");
  });

  it("short-circuits on block (skips remaining handlers)", async () => {
    let secondHandlerCalled = false;
    const registry = makeRegistry([
      {
        pluginId: "plugin-a",
        hookName: "before_agent_run",
        handler: async () => ({
          outcome: "block" as const,
          reason: "blocked",
        }),
        source: "test",
        priority: 10,
      },
      {
        pluginId: "plugin-b",
        hookName: "before_agent_run",
        handler: async () => {
          secondHandlerCalled = true;
          return { outcome: "pass" as const };
        },
        source: "test",
        priority: 5,
      },
    ]);
    const runner = createHookRunner(registry);
    await runner.runBeforeAgentRun({ prompt: "test", messages: [] }, ctx);
    expect(secondHandlerCalled).toBe(false);
  });

  it("treats void handler returns as pass (no effect)", async () => {
    const registry = makeRegistry([
      {
        pluginId: "void-plugin",
        hookName: "before_agent_run",
        handler: async () => undefined,
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentRun({ prompt: "test", messages: [] }, ctx);
    // void => undefined result (no decision)
    expect(result).toBeUndefined();
  });

  it("receives the correct event payload", async () => {
    let receivedEvent: unknown;
    const registry = makeRegistry([
      {
        pluginId: "test",
        hookName: "before_agent_run",
        handler: async (event: unknown) => {
          receivedEvent = event;
          return { outcome: "pass" as const };
        },
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);
    await runner.runBeforeAgentRun(
      {
        prompt: "hello world",
        messages: [{ role: "user", content: "hello" }],
        channelId: "discord",
        senderId: "user-123",
        senderIsOwner: true,
      },
      ctx,
    );
    const event = receivedEvent as Record<string, unknown>;
    expect(event.prompt).toBe("hello world");
    expect(event.channelId).toBe("discord");
    expect(event.senderId).toBe("user-123");
    expect(event.senderIsOwner).toBe(true);
  });
});

describe("before_agent_run redact guard", () => {
  it("treats redact as block in before_agent_run (redact is invalid for input gates)", async () => {
    const registry = makeRegistry([
      {
        pluginId: "test",
        hookName: "before_agent_run",
        handler: async () => ({
          outcome: "redact" as const,
          reason: "should not be redact",
        }),
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry, {
      logger: { warn: () => {}, error: () => {} },
    });
    const result = await runner.runBeforeAgentRun({ prompt: "test", messages: [] }, ctx);
    expect(result?.outcome).toBe("block");
  });
});

describe("before_tool_call channelId forwarding", () => {
  it("passes channelId through to before_tool_call handlers", async () => {
    let receivedCtx: unknown;
    const registry = makeRegistry([
      {
        pluginId: "test",
        hookName: "before_tool_call",
        handler: async (_event: unknown, ctx: unknown) => {
          receivedCtx = ctx;
          return undefined;
        },
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);
    await runner.runBeforeToolCall(
      { toolName: "exec", params: {} },
      { toolName: "exec", channelId: "discord", sessionKey: "s1" },
    );
    expect((receivedCtx as { channelId?: string }).channelId).toBe("discord");
  });
});
