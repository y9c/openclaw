# Lifecycle Hook E2E Test Results

**Date:** 2026-04-24
**Browser:** WebKit (Safari)
**Gateway:** Dev gateway on port 19004 (worktree `lifecycle-hooks`)
**Model:** claude-opus-4-6 via atlassian-ai-gateway-proxy
**Suite:** 9 tests

## Results Summary

| #   | Test                                                                                    | Status  |
| --- | --------------------------------------------------------------------------------------- | ------- |
| 1   | Normal message (no hook trigger)                                                        | ✅ Pass |
| 2   | HOOK_BLOCK_RUN — before_agent_run block                                                 | ✅ Pass |
| 3   | HOOK_ASK_RUN — before_agent_run ask (approve)                                           | ✅ Pass |
| 4   | HOOK_ASK_RUN — before_agent_run ask (deny)                                              | ✅ Pass |
| 5   | HOOK_BLOCK_OUTPUT — llm_output block                                                    | ✅ Pass |
| 6   | HOOK_BLOCK_OUTPUT — UI replaces streamed text with block warning                        | ✅ Pass |
| 7   | HOOK_BLOCK_RETRY — llm_output block with retry                                          | ✅ Pass |
| 8   | HOOK_ASK_TOOL_INPUT — must pause tool dispatch for approval                             | ✅ Pass |
| 9   | HOOK_BLOCK_RETRY — retry notices appear as assistant bubbles, no duplicate user bubbles | ✅ Pass |

> **Removed:** `HOOK_ASK_OUTPUT` (llm_output ask) — not enforceable for tool-using turns. See `docs/refactor/hook-output-gating-limitations.md`.

## Trigger Taxonomy

| Trigger                 | Hook               | Effect                                                                                                                                                                                                 |
| ----------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HOOK_BLOCK_RUN`        | `before_agent_run` | Block entire run. User bubble preserved with `🛡️ Hidden from agents` banner. Agent sees policy stub only.                                                                                              |
| `HOOK_ASK_RUN`          | `before_agent_run` | Approval prompt before LLM call. Approve → normal. Deny → user bubble preserved, turn ends.                                                                                                            |
| `HOOK_BLOCK_OUTPUT`     | `llm_output`       | Block LLM text reply. Streamed text replaced with `⚠️ Agent failed before reply:` block notice. Persisted JSONL scrubbed so reload doesn't resurrect original text.                                    |
| `HOOK_BLOCK_RETRY`      | `llm_output`       | Block + retry. Each attempt's assistant bubble replaced in-place with `⚠️ Response blocked — retrying (N/M)...`. No duplicate user bubbles. Final message shows `⚠️ Response blocked after N retries.` |
| `HOOK_BLOCK_TOOL_INPUT` | `before_tool_call` | Block tool execution. Tool body never runs (no side effects). Styled block message.                                                                                                                    |
| `HOOK_ASK_TOOL_INPUT`   | `before_tool_call` | Approval prompt before tool execution. Approve → tool runs. Deny → tool blocked.                                                                                                                       |

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

## Files Modified

### Backend

- `src/agents/pi-embedded-runner/run/attempt.ts` — inline `llm_output` block, retry dedupe, ASK_RUN deny persistence, retry notice replacement
- `src/agents/pi-embedded-subscribe.handlers.ts` — removed `detach: true` from `tool_execution_end`
- `src/agents/pi-embedded-subscribe.handlers.tools.ts` — reordered tool output emission after hook, observer-only `after_tool_call` fireAsync
- `src/plugins/hook-redaction.ts` — `redactDuplicateUserMessage` helper
- `src/plugins/hook-decision-types.ts` — `resolveBlockMessage` falls back to `reason`
- `src/config/sessions/transcript.ts` — `appendBlockedUserMessageToSessionTranscript`
- `src/gateway/session-utils.fs.ts` — forward `originalBlockedContent` sidecar
- `extensions/hook-echo/index.ts` — `before_message_write` handler, `before_tool_call` tool triggers, session-scoped state, styled messages

### SPA

- `ui/src/ui/chat/message-extract.ts` — render `originalBlockedContent` for user messages
- `ui/src/ui/chat/message-normalizer.ts` — read `originalBlockedContent` in `normalizeMessage`
- `ui/src/ui/chat/grouped-render.ts` — `🛡️ Hidden from agents` banner for blocked user messages

### Tests

- `src/plugins/hook-redaction.test.ts` — `redactDuplicateUserMessage` unit tests
- `e2e/hooks-e2e.spec.ts` — 11 comprehensive WebKit E2E tests
- `e2e/playwright.config.ts` — WebKit-only config, port 19004
- `e2e/RESULTS.md` — this file
