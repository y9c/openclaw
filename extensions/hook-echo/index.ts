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
 *
 *   NOTE: The following are intentionally not exposed here today —
 *   see docs/refactor/hook-output-gating-limitations.md:
 *     - HOOK_ASK_OUTPUT  (llm_output ASK; cannot pause tool-using turns)
 *     - HOOK_ASYNC_BLOCK (async llm_output intervene; no UI surface)
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
 *   HOOK_BLOCK_RETRY        → llm_output BLOCK + retry (LLM blocked but runner re-asks the model)
 *   HOOK_BLOCK_TOOL_INPUT   → before_tool_call BLOCK   (tool blocked before execute(); turn ends)
 *   HOOK_ASK_TOOL_INPUT     → before_tool_call ASK     (tool paused for approval before execute())
 *   HOOK_ASYNC_BLOCK        → llm_output ASYNC BLOCK   (post-delivery async intervention)
 *
 * Run-scoped state lets `before_tool_call` know whether the originating
 * user prompt for the current `runId` requested tool gating. Cleanup
 * happens at `agent_end`. Set is capped as belt-and-braces against leaks
 * if a run crashes before `agent_end` fires.
 */
const askToolInputRunIds = new Set<string>();
const blockToolInputRunIds = new Set<string>();
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

      // Record run-scoped tool-stage gates so `before_tool_call` knows
      // whether to gate this run. The OUTPUT/RUN triggers are NOT
      // propagated here on purpose — `HOOK_BLOCK_OUTPUT` and friends
      // only block the LLM's text reply, not tool calls.
      if (hasTrigger(currentUserMsg, "HOOK_ASK_TOOL_INPUT")) {
        rememberRunGate(askToolInputRunIds, ctx.runId);
      }
      if (hasTrigger(currentUserMsg, "HOOK_BLOCK_TOOL_INPUT")) {
        rememberRunGate(blockToolInputRunIds, ctx.runId);
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

    // NOTE: async-mode handlers (`mode: "async"`) were removed from this
    // diagnostic plugin. The runner DOES fire async handlers and the
    // `controller.intervene` callback DOES collect a decision, but that
    // decision currently has no effect on the user-visible chat UI: the
    // intervention is logged and dispatched but no SPA seam renders it
    // as a follow-up retraction notice. Until that path is wired (see
    // docs/refactor/hook-output-gating-limitations.md), the async
    // examples here only added confusion to manual smoke tests.

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

      // NOTE: HOOK_ASK_OUTPUT was removed — see
      // docs/refactor/hook-output-gating-limitations.md for why
      // llm_output ASK is not enforceable today.

      return { outcome: "pass" as const };
    });

    // NOTE: async llm_output handler removed alongside the async
    // before_agent_run example above. See the limitations doc for the
    // architectural reason and the pending follow-up work.

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

    // ─── before_message_write (sync) ─────────────────────────────────
    // Generic message-write guard. Currently used to suppress empty user
    // messages emitted by retry attempts (prompt("") ghost boxes).
    api.on("before_message_write", (event) => {
      const msg = event.message as unknown as Record<string, unknown> | undefined;

      // Block empty user messages from retry attempts (prompt("") ghost boxes)
      if (msg?.role === "user") {
        const content = msg.content;
        const isEmpty =
          !content ||
          (Array.isArray(content) &&
            (content as Array<Record<string, unknown>>).every(
              (c) => !c?.text || (typeof c.text === "string" && c.text.trim() === ""),
            )) ||
          (typeof content === "string" && content.trim() === "");
        if (isEmpty) {
          log.info(
            `[${PLUGIN_ID}] before_message_write → BLOCKING empty user message (retry ghost)`,
          );
          return { block: true };
        }
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
    });
  },
});
