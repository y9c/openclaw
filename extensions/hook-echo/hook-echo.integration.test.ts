import { describe, expect, it } from "vitest";
import type { HookController } from "../../src/plugins/hook-decision-types.js";
import type { GlobalHookRunnerRegistry } from "../../src/plugins/hook-registry.types.js";
import type {
  PluginHookRegistration,
  PluginHookAgentContext,
  PluginHookToolContext,
  PluginHookBeforeAgentRunEvent,
  PluginHookLlmOutputEvent,
} from "../../src/plugins/hook-types.js";
import { createHookRunner } from "../../src/plugins/hooks.js";

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

describe("hook-echo integration", () => {
  describe("llm_output decision", () => {
    it("returns pass from a sync llm_output handler", async () => {
      const registry = makeRegistry([
        {
          pluginId: "hook-echo",
          hookName: "llm_output",
          handler: async (_event: PluginHookLlmOutputEvent) => {
            return { outcome: "pass" as const };
          },
          source: "hook-echo",
        },
      ]);
      const runner = createHookRunner(registry);
      const result = await runner.runLlmOutput(
        {
          runId: "r1",
          sessionId: "s1",
          provider: "openai",
          model: "gpt-5.4",
          assistantTexts: ["hello"],
        },
        ctx,
      );
      expect(result?.outcome).toBe("pass");
    });

    it("returns block from a sync llm_output handler", async () => {
      const registry = makeRegistry([
        {
          pluginId: "hook-echo",
          hookName: "llm_output",
          handler: async () => ({
            outcome: "block" as const,
            reason: "unsafe",
          }),
          source: "hook-echo",
        },
      ]);
      const runner = createHookRunner(registry);
      const result = await runner.runLlmOutput(
        {
          runId: "r1",
          sessionId: "s1",
          provider: "openai",
          model: "gpt-5.4",
          assistantTexts: ["bad"],
        },
        ctx,
      );
      expect(result?.outcome).toBe("block");
    });
  });

  describe("after_tool_call decision", () => {
    it("returns undefined when handler returns void (observe only)", async () => {
      const registry = makeRegistry([
        {
          pluginId: "hook-echo",
          hookName: "after_tool_call",
          handler: async () => {
            // observe only — no decision
          },
          source: "hook-echo",
        },
      ]);
      const runner = createHookRunner(registry);
      const toolCtx: PluginHookToolContext = {
        toolName: "exec",
        sessionKey: "s1",
        runId: "r1",
      };
      const result = await runner.runAfterToolCall(
        { toolName: "exec", params: {}, result: "ok" },
        toolCtx,
      );
      expect(result).toBeUndefined();
    });

    it("returns redact from after_tool_call handler", async () => {
      const registry = makeRegistry([
        {
          pluginId: "hook-echo",
          hookName: "after_tool_call",
          handler: async () => ({
            outcome: "redact" as const,
            reason: "sensitive output",
          }),
          source: "hook-echo",
        },
      ]);
      const runner = createHookRunner(registry);
      const result = await runner.runAfterToolCall(
        { toolName: "exec", params: {}, result: "secret data" },
        { toolName: "exec", sessionKey: "s1" },
      );
      expect(result?.outcome).toBe("redact");
    });
  });

  describe("async handler behavior", () => {
    it("async handlers do not block the sync path", async () => {
      let asyncHandlerCompleted = false;
      const registry = makeRegistry([
        {
          pluginId: "sync-plugin",
          hookName: "before_agent_run",
          handler: async () => ({ outcome: "pass" as const }),
          source: "sync-plugin",
          // mode defaults to sync
        },
        {
          pluginId: "async-plugin",
          hookName: "before_agent_run",
          handler: async () => {
            await new Promise((r) => setTimeout(r, 200));
            asyncHandlerCompleted = true;
            return { outcome: "pass" as const };
          },
          source: "async-plugin",
          mode: "async" as const,
        },
      ]);
      const runner = createHookRunner(registry);

      // The sync path should return immediately without waiting for async
      const result = await runner.runBeforeAgentRun({ prompt: "test", messages: [] }, ctx);
      expect(result?.outcome).toBe("pass");
      // Async handler should NOT have completed yet
      expect(asyncHandlerCompleted).toBe(false);
    });

    it("fireAsync invokes async handlers and supports intervention", async () => {
      let interventionReceived: unknown;
      const registry = makeRegistry([
        {
          pluginId: "async-moderator",
          hookName: "before_agent_run",
          handler: async (
            _event: PluginHookBeforeAgentRunEvent,
            _ctx: PluginHookAgentContext,
            controller?: HookController,
          ) => {
            controller?.intervene({
              outcome: "block" as const,
              reason: "async block",
            });
          },
          source: "async-moderator",
          mode: "async" as const,
        },
      ]);
      const runner = createHookRunner(registry);

      const cleanup = runner.fireAsync(
        "before_agent_run",
        { prompt: "test", messages: [] },
        ctx,
        (decision, pluginId) => {
          interventionReceived = { decision, pluginId };
        },
      );

      // Wait a tick for the async handler to fire
      await new Promise((r) => setTimeout(r, 50));
      expect(interventionReceived).toBeDefined();
      expect((interventionReceived as { decision: { outcome: string } }).decision.outcome).toBe(
        "block",
      );

      cleanup();
    });
  });
});
