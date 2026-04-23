# Lifecycle Hook E2E Test Results

**Date:** 2026-04-23
**Browser:** WebKit (Safari)
**Gateway:** Dev gateway on port 19005 (worktree `lifecycle-hooks`)
**Model:** claude-opus-4-6 via atlassian-ai-gateway-proxy
**Suite:** 13 tests, 1.8m total runtime

## Results Summary

| #   | Test                                                                             | Status  | Time  |
| --- | -------------------------------------------------------------------------------- | ------- | ----- |
| 1   | Normal message (no hook trigger)                                                 | ✅ Pass | 14.0s |
| 2   | HOOK_BLOCK_RUN — before_agent_run block                                          | ✅ Pass | 2.2s  |
| 3   | HOOK_ASK_RUN — before_agent_run ask (approve)                                    | ✅ Pass | 6.7s  |
| 4   | HOOK_ASK_RUN — before_agent_run ask (deny)                                       | ✅ Pass | 2.2s  |
| 5   | HOOK_BLOCK_OUTPUT — llm_output block                                             | ✅ Pass | 7.5s  |
| 6   | HOOK_BLOCK_OUTPUT — UI replaces streamed text with block warning                 | ✅ Pass | 19.9s |
| 7   | HOOK_BLOCK_RETRY — llm_output block with retry                                   | ✅ Pass | 5.8s  |
| 8   | HOOK_ASK_OUTPUT — llm_output ask (approve)                                       | ✅ Pass | 7.5s  |
| 9   | HOOK_ASK_OUTPUT — llm_output ask (deny)                                          | ✅ Pass | 5.8s  |
| 10  | HOOK_ASK_TOOL_INPUT — must pause tool dispatch for approval                      | ✅ Pass | 6.5s  |
| 11  | HOOK_BLOCK_RETRY — retry notices in assistant bubbles, no duplicate user bubbles | ✅ Pass | 21.7s |
| 12  | HOOK_BLOCK_TOOL_OUTPUT — tool runs, then turn ends with styled block message     | ✅ Pass | 3.9s  |
| 13  | HOOK_ASK_TOOL_OUTPUT — tool result substituted, model never sees real output     | ✅ Pass | 5.1s  |

## Trigger Taxonomy

| Trigger                  | Hook                                       | Effect                                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HOOK_BLOCK_RUN`         | `before_agent_run`                         | Block entire run. User bubble preserved with `🛡️ Hidden from agents` banner. Agent sees policy stub only.                                                                                              |
| `HOOK_ASK_RUN`           | `before_agent_run`                         | Approval prompt before LLM call. Approve → normal. Deny → user bubble preserved, turn ends.                                                                                                            |
| `HOOK_BLOCK_OUTPUT`      | `llm_output`                               | Block LLM text reply. Streamed text replaced with `⚠️ Agent failed before reply:` block notice. Persisted JSONL scrubbed so reload doesn't resurrect original text.                                    |
| `HOOK_BLOCK_RETRY`       | `llm_output`                               | Block + retry. Each attempt's assistant bubble replaced in-place with `⚠️ Response blocked — retrying (N/M)...`. No duplicate user bubbles. Final message shows `⚠️ Response blocked after N retries.` |
| `HOOK_ASK_OUTPUT`        | `llm_output`                               | Approval prompt on LLM text. Approve → text delivered. Deny → text replaced with denial notice.                                                                                                        |
| `HOOK_BLOCK_TOOL_INPUT`  | `before_tool_call`                         | Block tool execution. Tool body never runs (no side effects). Styled block message.                                                                                                                    |
| `HOOK_ASK_TOOL_INPUT`    | `before_tool_call`                         | Approval prompt before tool execution. Approve → tool runs. Deny → tool blocked.                                                                                                                       |
| `HOOK_BLOCK_TOOL_OUTPUT` | `after_tool_call` + `before_message_write` | Tool runs (side effects happen), but result blocked from persistence and model. Styled `⚠️ Agent failed before reply:` block notice.                                                                   |
| `HOOK_ASK_TOOL_OUTPUT`   | `after_tool_call` + `before_message_write` | Tool runs, result substituted with policy notice via `before_message_write`. Model never sees real output.                                                                                             |

## Bugs Fixed

### Bug 1: `redactMessages` shape mismatch

- **Root cause:** `match` filter checked top-level `role`/`content`, but real JSONL entries use `{type:"message", message:{role, content:[...]}}`.
- **Fix:** Updated matcher to read nested `entry.parsed.message.role` and `entry.parsed.message.content[*].text`.
- **Tests:** 17 unit tests in `src/plugins/hook-redaction.test.ts`.

### Bug 2: HOOK_BLOCK_OUTPUT — streamed text survives reload

- **Root cause:** Inline block path emitted `state: "final"` with replacement text but didn't scrub the prior streamed assistant message from JSONL. SPA's `chat.history` reload restored the original streamed text.
- **Fix:** After inline block, call `redactMessages` targeting the prior assistant text, then persist the replacement message.
- **Tests:** E2e test #6 uses a unique nonce in the prompt, waits for reload, and asserts no assistant bubble contains the nonce.

### Bug 3: HOOK_BLOCK_RUN — user bubble shows policy text

- **Root cause:** `appendBlockedUserMessageToSessionTranscript` persists `originalBlockedContent` sidecar, but `normalizeMessage` in SPA didn't check it. The bubble rendered `message.content` (policy stub) instead of the original.
- **Fix:** Added `originalBlockedContent` check in `normalizeMessage` and `extractText` for user-role messages. SPA now shows original text with `🛡️ Hidden from agents` banner.

### Bug 4: HOOK_ASK_RUN (deny) — user bubble lost

- **Root cause:** On deny, `skipPromptSubmission = true` so SDK never persisted the user message.
- **Fix:** Added `appendBlockedUserMessageToSessionTranscript` call on the deny path.

### Bug 5: HOOK_BLOCK_RETRY — duplicate user bubbles stacked

- **Root cause:** On retry, `activeSession.prompt()` re-persists the user message.
- **Fix:** Added `redactDuplicateUserMessage` helper that scrubs the latest duplicate after prompt() on retry attempts.

### Bug 6: HOOK_BLOCK_RETRY — messages disappear instead of showing retry notice

- **Root cause:** `replaceLlmOutputResponse` scrubbed the assistant message entirely on retry, leaving a blank gap.
- **Fix:** On retry, persist a replacement assistant message with `⚠️ Response blocked — retrying (N/M)...` + reason. On final exhaustion, persist `⚠️ Response blocked after N retries.` + reason.

### Bug 7: HOOK_BLOCK_TOOL_OUTPUT — generic "This response was blocked by policy"

- **Root cause:** Plugin returned `reason` but not `message`/`userMessage`. `resolveBlockMessage` didn't fall back to `reason`.
- **Fix:** Updated `resolveBlockMessage` to check `reason` before the generic default. Also added `message`/`userMessage` to hook-echo's after_tool_call return.

### Bug 8: HOOK_BLOCK_TOOL_OUTPUT — tool result persisted to transcript

- **Root cause:** Tool result was persisted before `after_tool_call` could block it.
- **Fix:** Added `before_message_write` hook in hook-echo that blocks `toolResult` persistence for sessions with `HOOK_BLOCK_TOOL_OUTPUT` trigger. Fixed session-tool-result-guard-wrapper to always wire `beforeMessageWrite` and pass `sessionKey` in the event.

### Bug 9: HOOK_ASK_TOOL_OUTPUT — tool result unredacted

- **Root cause:** Same as Bug 8 but for ASK path. `after_tool_call` is observational, not a gating seam.
- **Fix:** `before_message_write` hook substitutes `toolResult` content with policy notice for sessions with `HOOK_ASK_TOOL_OUTPUT` trigger. Model continues but never sees real tool output.

## Architectural Notes

### `after_tool_call` is observational, not a gating seam

The `tool_execution_end` event fires after the tool result is already available to the SDK. The model loop can advance before `after_tool_call` handlers complete. True tool-output gating is implemented via `before_message_write` in the session transcript guard, which fires synchronously before persistence.

### `HOOK_ASK_TOOL_OUTPUT` — no interactive approval prompt

The `before_message_write` substitution prevents the real tool output from reaching the model, but there is no interactive approval prompt surfaced to the user. Implementing true interactive approval for tool output would require a new SDK-level gating seam at the tool-result handoff boundary.

### `HOOK_BLOCK_TOOL_INPUT` vs `HOOK_BLOCK_TOOL_OUTPUT`

- **INPUT:** Pre-execution gate. Tool body never runs — no side effects.
- **OUTPUT:** Post-execution gate. Tool already ran (side effects happened). Only the result is blocked from reaching the model.

## Files Modified

### Backend

- `src/agents/pi-embedded-runner/run/attempt.ts` — inline `llm_output` block, retry dedupe, ASK_RUN deny persistence, tool block styling, retry notice replacement
- `src/agents/pi-embedded-subscribe.handlers.ts` — removed `detach: true` from `tool_execution_end`
- `src/agents/pi-embedded-subscribe.handlers.tools.ts` — reordered tool output emission after hook, styled block messages, approval path
- `src/agents/session-tool-result-guard-wrapper.ts` — always wire `beforeMessageWrite`, pass `sessionKey` in event
- `src/plugins/hook-redaction.ts` — `redactDuplicateUserMessage` helper
- `src/plugins/hook-decision-types.ts` — `resolveBlockMessage` falls back to `reason`
- `src/config/sessions/transcript.ts` — `appendBlockedUserMessageToSessionTranscript`
- `src/gateway/session-utils.fs.ts` — forward `originalBlockedContent` sidecar
- `extensions/hook-echo/index.ts` — `before_message_write` handler, `before_tool_call`/`after_tool_call` tool triggers, session-scoped state, styled messages

### SPA

- `ui/src/ui/chat/message-extract.ts` — render `originalBlockedContent` for user messages
- `ui/src/ui/chat/message-normalizer.ts` — read `originalBlockedContent` in `normalizeMessage`
- `ui/src/ui/chat/grouped-render.ts` — `🛡️ Hidden from agents` banner for blocked user messages

### Tests

- `src/plugins/hook-redaction.test.ts` — `redactDuplicateUserMessage` unit tests
- `e2e/hooks-e2e.spec.ts` — 13 comprehensive WebKit E2E tests
- `e2e/playwright.config.ts` — WebKit-only config, port 19005
- `e2e/RESULTS.md` — this file
