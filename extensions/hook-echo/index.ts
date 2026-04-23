/**
 * Hook Echo Plugin — diagnostic/development plugin that exercises all lifecycle hooks.
 *
 * Always logs every hook event. Additionally, responds to magic trigger words
 * in the user prompt to exercise block/retry/async-intervention paths:
 *
 *   Prompt triggers (case-insensitive, matched anywhere in user message):
 *     "HOOK_BLOCK_RUN"     → before_agent_run returns block
 *     "HOOK_ASK_RUN"       → before_agent_run returns ask (human approval)
 *     "HOOK_BLOCK_OUTPUT"  → llm_output returns block with custom message
 *     "HOOK_BLOCK_RETRY"   → llm_output returns block with retry: true (test retry path)
 *     "HOOK_ASK_OUTPUT"    → llm_output returns ask (human approval)
 *     "HOOK_ASYNC_BLOCK"   → async llm_output intervenes with block
 *
 * Enable via config: plugins.entries.hook-echo.enabled = true
 */

import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const PLUGIN_ID = "hook-echo";

/**
 * Trigger taxonomy:
 *
 *   HOOK_BLOCK_RUN          → before_agent_run BLOCK   (turn never starts)
 *   HOOK_ASK_RUN            → before_agent_run ASK     (turn pauses for approval pre-LLM)
 *   HOOK_BLOCK_OUTPUT       → llm_output BLOCK         (LLM text reply blocked; tools NOT in scope)
 *   HOOK_ASK_OUTPUT         → llm_output ASK           (LLM text reply paused for approval; tools NOT in scope)
 *   HOOK_BLOCK_RETRY        → llm_output BLOCK + retry (LLM blocked but runner re-asks the model)
 *   HOOK_BLOCK_TOOL_INPUT   → before_tool_call BLOCK   (tool blocked before execute(); turn ends)
 *   HOOK_ASK_TOOL_INPUT     → before_tool_call ASK     (tool paused for approval before execute())
 *   HOOK_BLOCK_TOOL_OUTPUT  → after_tool_call BLOCK    (tool's result is rejected; turn ends)
 *   HOOK_ASK_TOOL_OUTPUT    → after_tool_call ASK      (tool's result paused for approval before flowing back to LLM)
 *   HOOK_ASYNC_BLOCK        → llm_output ASYNC BLOCK   (post-delivery async intervention)
 *
 * Run-scoped state lets `before_tool_call` and `after_tool_call` know
 * whether the originating user prompt for the current `runId` requested
 * tool gating. Cleanup happens at `agent_end`. Set is capped as
 * belt-and-braces against leaks if a run crashes before `agent_end` fires.
 */
const askToolInputRunIds = new Set<string>();
const blockToolInputRunIds = new Set<string>();
const askToolOutputRunIds = new Set<string>();
const blockToolOutputRunIds = new Set<string>();
// Session-scoped gating used by before_message_write, which doesn't carry runId.
const askToolOutputSessionKeys = new Set<string>();
const blockToolOutputSessionKeys = new Set<string>();
const MAX_TRACKED_RUN_IDS = 1024;

function rememberRunGate(set: Set<string>, runId: string | undefined): void {
  if (!runId) {
    return;
  }
  set.add(runId);
  if (set.size > MAX_TRACKED_RUN_IDS) {
    const oldest = set.values().next().value;
    if (oldest) {
      set.delete(oldest);
    }
  }
}

function forgetRunGates(runId: string | undefined): void {
  if (!runId) {
    return;
  }
  askToolInputRunIds.delete(runId);
  blockToolInputRunIds.delete(runId);
  askToolOutputRunIds.delete(runId);
  blockToolOutputRunIds.delete(runId);
}

/** Check if text contains a trigger (case-insensitive). */
function hasTrigger(text: string | undefined, trigger: string): boolean {
  return !!text && text.toUpperCase().includes(trigger);
}

/**
 * Extract the current user message from the assembled prompt string.
 * The prompt assembles messages chronologically, so the latest user
 * message is near the end.  We walk backwards to find the last
 * timestamp line (the current turn) and return everything from there.
 */
function extractCurrentUserMessage(prompt: string | undefined): string {
  if (!prompt) {
    return "";
  }
  const lines = prompt.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s/.test(lines[i])) {
      return lines.slice(i).join("\n");
    }
  }
  // No timestamp found — use last 500 chars as fallback
  return prompt.slice(-500);
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Hook Echo",
  description:
    "Diagnostic plugin — logs all lifecycle hooks and exercises block/retry/async paths via trigger words",

  register(api: OpenClawPluginApi) {
    const log = api.logger ?? console;

    // ─── before_agent_run (sync) ───────────────────────────────────────
    api.on("before_agent_run", async (event, ctx) => {
      const promptPreview = (event.prompt ?? "").slice(0, 120);
      log.info(
        `[${PLUGIN_ID}] before_agent_run fired — ` +
          `prompt=${JSON.stringify(promptPreview)} ` +
          `channelId=${event.channelId ?? "none"} ` +
          `senderIsOwner=${event.senderIsOwner ?? "unknown"} ` +
          `sessionKey=${ctx.sessionKey ?? "none"} runId=${ctx.runId ?? "none"}`,
      );

      const currentUserMsg = extractCurrentUserMessage(event.prompt);

      // Record run-scoped tool-stage gates so `before_tool_call` and
      // `after_tool_call` know whether to gate this run. The OUTPUT/RUN
      // triggers are NOT propagated here on purpose — `HOOK_BLOCK_OUTPUT`
      // and friends only block the LLM's text reply, not tool calls.
      if (hasTrigger(currentUserMsg, "HOOK_ASK_TOOL_INPUT")) {
        rememberRunGate(askToolInputRunIds, ctx.runId);
      }
      if (hasTrigger(currentUserMsg, "HOOK_BLOCK_TOOL_INPUT")) {
        rememberRunGate(blockToolInputRunIds, ctx.runId);
      }
      if (hasTrigger(currentUserMsg, "HOOK_ASK_TOOL_OUTPUT")) {
        rememberRunGate(askToolOutputRunIds, ctx.runId);
        if (ctx.sessionKey) {
          askToolOutputSessionKeys.add(ctx.sessionKey);
        }
      }
      if (hasTrigger(currentUserMsg, "HOOK_BLOCK_TOOL_OUTPUT")) {
        rememberRunGate(blockToolOutputRunIds, ctx.runId);
        if (ctx.sessionKey) {
          blockToolOutputSessionKeys.add(ctx.sessionKey);
        }
      }

      if (hasTrigger(currentUserMsg, "HOOK_BLOCK_RUN")) {
        log.info(`[${PLUGIN_ID}] before_agent_run → BLOCKING (trigger: HOOK_BLOCK_RUN)`);
        return {
          outcome: "block" as const,
          reason: "[hook-echo] Run blocked by HOOK_BLOCK_RUN trigger",
          message: "🚫 [hook-echo] This run was blocked by the hook-echo diagnostic plugin.",
        };
      }

      if (hasTrigger(currentUserMsg, "HOOK_ASK_RUN")) {
        log.info(`[${PLUGIN_ID}] before_agent_run → ASKING (trigger: HOOK_ASK_RUN)`);
        return {
          outcome: "ask" as const,
          reason: "[hook-echo] Run requires approval — HOOK_ASK_RUN trigger",
          title: "Hook Echo: Run Approval",
          description: "The hook-echo diagnostic plugin flagged this prompt for human review.",
          severity: "warning" as const,
          timeoutMs: 60_000,
          timeoutBehavior: "deny" as const,
          denialMessage: "🚫 [hook-echo] Run denied — approval was not granted.",
        };
      }

      return { outcome: "pass" as const };
    });

    // ─── before_agent_run (async) ──────────────────────────────────────
    api.on(
      "before_agent_run",
      async (event, _ctx, controller) => {
        log.info(`[${PLUGIN_ID}] async before_agent_run started — simulating slow check`);
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (controller?.signal.aborted) {
          log.info(`[${PLUGIN_ID}] async before_agent_run — aborted, skipping`);
          return;
        }
        log.info(`[${PLUGIN_ID}] async before_agent_run — slow check complete, all clear`);
      },
      { mode: "async", timeoutMs: 5000 },
    );

    // ─── llm_output (sync) ────────────────────────────────────────────
    api.on("llm_output", async (event, ctx) => {
      const textPreview = (event.assistantTexts ?? []).join(" ").slice(0, 120);
      log.info(
        `[${PLUGIN_ID}] llm_output fired — ` +
          `texts=${JSON.stringify(textPreview)} ` +
          `model=${event.model} provider=${event.provider} ` +
          `sessionKey=${ctx.sessionKey ?? "none"} runId=${ctx.runId ?? "none"}`,
      );

      // Only check the last user message to avoid matching trigger words
      // that appear in conversation history (e.g. assistant quoting triggers).
      const currentUserMsg = extractCurrentUserMessage(event.prompt);
      if (hasTrigger(currentUserMsg, "HOOK_BLOCK_RETRY")) {
        log.info(`[${PLUGIN_ID}] llm_output → BLOCKING with retry (trigger: HOOK_BLOCK_RETRY)`);
        return {
          outcome: "block" as const,
          reason:
            "[hook-echo] Output blocked by HOOK_BLOCK_RETRY trigger — asking LLM to try again",
          message:
            "🔁 [hook-echo] Response was blocked and retried by the hook-echo diagnostic plugin.",
          retry: true,
          maxRetries: 2,
        };
      }

      if (hasTrigger(currentUserMsg, "HOOK_BLOCK_OUTPUT")) {
        log.info(`[${PLUGIN_ID}] llm_output → BLOCKING (trigger: HOOK_BLOCK_OUTPUT)`);
        return {
          outcome: "block" as const,
          reason: "[hook-echo] Output blocked by HOOK_BLOCK_OUTPUT trigger",
          message: "🔒 [hook-echo] This response was blocked by the hook-echo diagnostic plugin.",
        };
      }

      if (hasTrigger(currentUserMsg, "HOOK_ASK_OUTPUT")) {
        log.info(`[${PLUGIN_ID}] llm_output → ASKING (trigger: HOOK_ASK_OUTPUT)`);
        return {
          outcome: "ask" as const,
          reason: "[hook-echo] Output requires approval — HOOK_ASK_OUTPUT trigger",
          title: "Hook Echo: Output Review",
          description:
            "The hook-echo diagnostic plugin flagged this response for human review. Approve to deliver, deny to retract.",
          severity: "info" as const,
          timeoutMs: 60_000,
          timeoutBehavior: "deny" as const,
          denialMessage: "🔒 [hook-echo] Response withheld — approval was not granted.",
        };
      }

      return { outcome: "pass" as const };
    });

    // ─── llm_output (async) ───────────────────────────────────────────
    api.on(
      "llm_output",
      async (event, ctx, controller) => {
        const currentUserMsg = extractCurrentUserMessage(event.prompt);

        log.info(`[${PLUGIN_ID}] async llm_output started`);

        // Simulate slow async analysis
        await new Promise((resolve) => setTimeout(resolve, 200));
        if (controller?.signal.aborted) {
          log.info(`[${PLUGIN_ID}] async llm_output — aborted`);
          return;
        }

        if (hasTrigger(currentUserMsg, "HOOK_ASYNC_BLOCK")) {
          log.info(
            `[${PLUGIN_ID}] async llm_output → BLOCKING via intervene (trigger: HOOK_ASYNC_BLOCK)`,
          );
          controller?.intervene({
            outcome: "block" as const,
            reason: "[hook-echo] Output async-blocked by HOOK_ASYNC_BLOCK trigger",
            message:
              "🔒 [hook-echo] This response was async-blocked by the hook-echo diagnostic plugin.",
          });
          return;
        }

        log.info(`[${PLUGIN_ID}] async llm_output — check complete, no intervention`);
      },
      { mode: "async", timeoutMs: 10000 },
    );

    // ─── before_tool_call (sync) ──────────────────────────────────────
    // Gates tool execution before the wrapped tool's `execute()` body
    // runs. Triggered by HOOK_BLOCK_TOOL_INPUT / HOOK_ASK_TOOL_INPUT in
    // the originating user prompt. Block here is the only seam where
    // tool side-effects are still reversible (the tool body has not yet
    // started).
    api.on("before_tool_call", async (event, ctx) => {
      const runId = ctx.runId;
      const askGated = runId ? askToolInputRunIds.has(runId) : false;
      const blockGated = runId ? blockToolInputRunIds.has(runId) : false;

      log.info(
        `[${PLUGIN_ID}] before_tool_call fired — ` +
          `tool=${event.toolName} runId=${runId ?? "none"} ` +
          `askGated=${askGated} blockGated=${blockGated}`,
      );

      if (blockGated) {
        log.info(
          `[${PLUGIN_ID}] before_tool_call → BLOCKING tool=${event.toolName} ` +
            `(HOOK_BLOCK_TOOL_INPUT trigger)`,
        );
        return {
          block: true,
          blockReason:
            `🔒 [hook-echo] Tool call '${event.toolName}' blocked by ` +
            `HOOK_BLOCK_TOOL_INPUT — the tool input was disallowed by policy.`,
        };
      }

      if (askGated) {
        log.info(
          `[${PLUGIN_ID}] before_tool_call → ASKING for approval tool=${event.toolName} ` +
            `(HOOK_ASK_TOOL_INPUT trigger)`,
        );
        return {
          requireApproval: {
            title: `Hook Echo: Tool Input Review (${event.toolName})`,
            description:
              `The agent wants to call the '${event.toolName}' tool. ` +
              `Approve to let the tool run; deny to block it. ` +
              `(Triggered by HOOK_ASK_TOOL_INPUT in the originating prompt.)`,
            severity: "warning" as const,
            timeoutMs: 60_000,
            timeoutBehavior: "deny" as const,
            pluginId: PLUGIN_ID,
          },
        };
      }

      return undefined;
    });

    // ─── after_tool_call (sync) ────────────────────────────────────────
    // Gates the tool's *result* before it flows back to the LLM. Triggered
    // by HOOK_BLOCK_TOOL_OUTPUT / HOOK_ASK_TOOL_OUTPUT in the originating
    // user prompt.
    //
    // NOTE: by the time this hook fires, the tool body has already
    // executed (any side effects already happened). The block decision
    // here prevents the result from being relayed to the LLM and ends
    // the turn; it cannot un-execute the tool. For pre-execution gating
    // use HOOK_BLOCK_TOOL_INPUT instead. The runtime currently logs the
    // block decision; full transcript replacement of the tool result is
    // a separate runner enhancement (TODO in
    // pi-embedded-subscribe.handlers.tools.ts).
    api.on("after_tool_call", async (event, ctx) => {
      const runId = ctx.runId;
      const askGated = runId ? askToolOutputRunIds.has(runId) : false;
      const blockGated = runId ? blockToolOutputRunIds.has(runId) : false;

      log.info(
        `[${PLUGIN_ID}] after_tool_call fired — ` +
          `tool=${event.toolName} ` +
          `durationMs=${event.durationMs ?? "unknown"} ` +
          `error=${event.error ?? "none"} ` +
          `sessionKey=${ctx.sessionKey ?? "none"} ` +
          `askGated=${askGated} blockGated=${blockGated}`,
      );

      if (blockGated) {
        log.info(
          `[${PLUGIN_ID}] after_tool_call → BLOCKING tool=${event.toolName} ` +
            `(HOOK_BLOCK_TOOL_OUTPUT trigger)`,
        );
        const msg =
          `🔒 [hook-echo] Tool result for '${event.toolName}' blocked by ` +
          `HOOK_BLOCK_TOOL_OUTPUT — the tool's output was disallowed by policy.`;
        return {
          outcome: "block" as const,
          reason: msg,
          message: msg,
          userMessage: msg,
        };
      }

      if (askGated) {
        log.info(
          `[${PLUGIN_ID}] after_tool_call → ASKING for approval tool=${event.toolName} ` +
            `(HOOK_ASK_TOOL_OUTPUT trigger)`,
        );
        const msg =
          `🔒 [hook-echo] Tool result for '${event.toolName}' requires human ` +
          `approval before flowing back to the LLM. (Triggered by ` +
          `HOOK_ASK_TOOL_OUTPUT in the originating prompt.)`;
        return {
          outcome: "requireApproval" as const,
          reason: msg,
          message: msg,
          userMessage: msg,
        };
      }

      return undefined;
    });

    // ─── before_message_write (sync) ─────────────────────────────────
    // This is the real gating seam for tool-output policy: it fires
    // synchronously before a message is persisted to the session JSONL.
    // For toolResult messages in sessions with HOOK_BLOCK_TOOL_OUTPUT or
    // HOOK_ASK_TOOL_OUTPUT triggers, we either block persistence entirely
    // or substitute the content with a policy notice.
    api.on("before_message_write", (event) => {
      const msg = event.message;
      const sk = event.sessionKey;

      // Only act on toolResult messages
      const isToolResult =
        msg?.role === "toolResult" ||
        (Array.isArray(msg?.content) &&
          msg.content.some(
            (c: Record<string, unknown>) => c?.type === "tool_result" || c?.type === "toolResult",
          ));
      if (!isToolResult || !sk) {
        return undefined;
      }

      if (blockToolOutputSessionKeys.has(sk)) {
        log.info(
          `[${PLUGIN_ID}] before_message_write → BLOCKING toolResult persistence ` +
            `(HOOK_BLOCK_TOOL_OUTPUT, sessionKey=${sk})`,
        );
        return { block: true };
      }

      if (askToolOutputSessionKeys.has(sk)) {
        log.info(
          `[${PLUGIN_ID}] before_message_write → SUBSTITUTING toolResult with ` +
            `approval-pending notice (HOOK_ASK_TOOL_OUTPUT, sessionKey=${sk})`,
        );
        // Replace tool result content with a policy notice so the model
        // never sees the real output. The turn will end via the
        // after_tool_call requireApproval path.
        const replaced = {
          ...msg,
          content: [
            {
              type: "text" as const,
              text:
                `🔒 [hook-echo] Tool result withheld pending human approval ` +
                `(triggered by HOOK_ASK_TOOL_OUTPUT).`,
            },
          ],
        };
        return { message: replaced };
      }

      return undefined;
    });

    // ─── agent_end (sync, cleanup) ─────────────────────────────────────
    // Evict run-scoped state once the run completes so we don't leak
    // memory or carry stale gates into subsequent runs that happen to
    // share a runId (the runner usually generates fresh ids, but defense
    // in depth).
    api.on("agent_end", async (_event, ctx) => {
      forgetRunGates(ctx.runId);
      if (ctx.sessionKey) {
        blockToolOutputSessionKeys.delete(ctx.sessionKey);
        askToolOutputSessionKeys.delete(ctx.sessionKey);
      }
    });
  },
});
