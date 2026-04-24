# Hook output-gating limitations

This document captures the architectural reasons why the following four
hook decisions cannot be properly enforced today, and what it would take
to fix each one. It is a snapshot from the lifecycle-hooks branch
(`feat/lifecycle-moderation-hooks`) — a record of decisions made during
the late-night design pass on 2026-04-24/25.

The TL;DR: openclaw never plugged into the `pi-coding-agent` extension
runner seam (`_extensionRunner`). Until it does, none of the four hooks
below can be enforced at the right point in the loop. Working around
the missing seam in core attempt code is possible for some cases but
ranges from "moderate refactor" to "real architectural work."

---

## 1. `HOOK_BLOCK_TOOL_OUTPUT` (ripped earlier in this session)

**Intent:** when a tool call produces output (e.g., `bash` returns text),
substitute or block that output **before the model sees it** in its
in-memory message array. Useful for redacting sensitive tool output,
blocking destructive results from reaching the model, etc.

**What worked today before the rip:** nothing model-side. We could
emit a styled "blocked" notice to the UI/transcript, but the LLM still
saw the raw real result on its next turn.

**Why:** openclaw's `after_tool_call` hook fired AFTER `pi-coding-agent`
had already pushed the tool result into `currentContext.messages`. The
SDK seam that _can_ substitute the in-memory result is in
`pi-agent-core/agent-loop.js` (`finalizeExecutedToolCall` → returns
`{content, details}` from `agent.afterToolCall`) and is also exposed to
plugins through `pi-coding-agent`'s `_extensionRunner.emitToolResult`.
openclaw never registered an extension runner with `bindExtensions(...)`,
so neither path is reachable from openclaw plugin code. Our
`onAfterToolCallBlock(...)` only ran the renderer-side suppression and
abort, never the in-memory substitution.

**Status:** Removed. Test #12 (`HOOK_BLOCK_TOOL_OUTPUT`) and the
turn-aborting `block` semantics under it were deleted along with
`session-tool-result-guard*`, dedicated test files, and the demo
trigger in `extensions/hook-echo/index.ts`.

**Fix shape (if we ever want it back):** implement a real extension
runner shim that `bindExtensions(...)` accepts. Route openclaw's
`after_tool_call` hook through `runner.emitToolResult`, which is
awaited by the SDK and whose return value substitutes the in-memory
message. Estimated: 5-8 hours (the runner has many lifecycle members,
not just `emitToolResult`).

---

## 2. `HOOK_ASK_TOOL_OUTPUT` (ripped earlier in this session)

**Intent:** before a tool result is returned to the LLM, ask a human to
review and approve / deny / edit it.

**What worked:** same as above — only renderer-side; the model never
actually paused for the human and would proceed with the real
unredacted result on the next turn.

**Why:** same root cause as `HOOK_BLOCK_TOOL_OUTPUT`. The SDK's
`afterToolCall` seam is awaited and could pause for human approval,
but openclaw doesn't own that seam.

**Status:** Removed in this branch.

**Fix shape:** same as above. Once openclaw owns the extension runner,
ASK becomes "await requestHookApproval inside emitToolResult, return
the approved/redacted content." Both `BLOCK_TOOL_OUTPUT` and
`ASK_TOOL_OUTPUT` come back together, no extra cost.

---

## 3. `HOOK_ASK_OUTPUT` (the LLM-output ASK — being ripped now)

**Intent:** before the LLM's reply is delivered to the user (and before
any tool calls in that turn fire), ask a human to review and approve.

**What works today:** the BLOCK variant works. `runLlmOutput` fires
inline at `message_end`, returns `outcome: "block"`, which calls
`onInlineLlmOutputBlock` → `activeSession.abort()`. That kills the SDK
loop entirely, so no further tool calls or LLM iterations happen. The
replacement text persists, the turn ends.

**Why ASK does not work the same way:**

The SDK's stream events (`message_end`, `text_end`, etc.) are emitted
through `_emit(event)` in `pi-coding-agent/agent-session.js` (line 214):

```js
_emit(event) {
  for (const l of this._eventListeners) {
    l(event);
  }
}
```

This is **fire-and-forget**. The SDK does not await the listener. So
even though our inline llm_output hook handler is `async`, awaiting
`requestHookApproval` inside it does NOT pause the SDK's loop. By the
time the human clicks Approve/Deny, the SDK has already moved on to
firing tool calls (via `agent.beforeToolCall`, which IS awaited but
runs concurrently with our event listener).

For BLOCK that is fine, because we abort the session — even if the SDK
has dispatched a tool, the abort signal stops it before completion.

For ASK that is broken, because:

- If we await approval before deciding to abort, tools have already
  run by the time we get the answer. The user sees a tool bubble
  appear, then a follow-up assistant message, then the approval
  dialog, then a denial that comes too late to matter.
- If we don't await and just fire `requestHookApproval` and ignore
  the result, ASK is purely cosmetic.

The deferred legacy ASK path at `attempt.ts:2778` (post-prompt())
fires AFTER the entire turn completes — including all tool calls and
all assistant messages. That is the dialog you see "at the end of the
whole agent's turn" in the screenshot from the manual smoke test on
2026-04-25 00:12. It is not a bug in the dialog; it is the only place
in the loop where awaiting actually has the user-visible effect of
"pause" (because there is nothing left to run).

**Status:** Being removed in this commit. The hook-echo trigger,
extension code paths, and the post-prompt() ASK orchestration in
`attempt.ts` are going away. The `llm_output.outcome === "block"`
inline path stays, because that one works.

**Fix shape:** implement the same extension-runner shim described
above and route `runLlmOutput` decisions through it. The runner needs
a hook that the SDK awaits at message_end (does not exist directly in
`pi-agent-core`; would have to live in `pi-coding-agent`'s extension
runner contract — a contract change). Until then, ASK on llm_output
cannot be enforced for tool-using turns.

### Future-work note: ASK approval timing for tool-using turns

If the proper extension-runner refactor lands, ASK should fire **after
each individual LLM message** (not just at end-of-turn). The runner
needs to await the human's decision before letting the SDK dispatch
any tool calls in that response. Otherwise the same "tool fired before
approval" UX bug we saw in the 2026-04-25 manual smoke test will come
back. The seam to use is `pi-coding-agent`'s `_extensionRunner`
(specifically a new awaited-message-end hook the runner needs to
expose), or alternatively replacing pi-coding-agent's
`agent.beforeToolCall` install with our own awaited gate.

A cheaper interim hack ("abort + replay") was considered:

1. ASK fires inline → abort the session immediately (same as BLOCK)
2. Show the approval dialog while the abort is propagating
3. If the user denies → done, replace text with denial message
4. If the user approves → re-prompt the SDK with the same effective
   prompt, marking the run as "ASK pre-approved" so the second pass
   does not ask again

This works mechanically but adds significant state-machine complexity
to the retry/run lifecycle and pays a real LLM regeneration cost on
every approval. Rejected for now in favor of "rip ASK_OUTPUT and
revisit when we own the extension runner."

---

## 4. `mode: "async"` hook handlers (HOOK_ASYNC_BLOCK and friends)

**Intent:** let a plugin register a fire-and-forget hook handler that
runs in parallel with the synchronous decision path. The async handler
gets a `controller` with `controller.intervene(decision)`, which is
intended to retract or replace a response _after_ it has already been
delivered to the user (post-hoc moderation, slow classifier calls, etc.).

**What works:** the runner-side plumbing.
`createHookRunner` correctly fires async handlers via `fireAsync(...)`
and routes their `controller.intervene(decision)` calls back to the
caller (covered by `extensions/hook-echo/hook-echo.integration.test.ts`).

**What does not work:** the user-visible UI surface. There is no SPA
seam today that consumes an async intervention and renders it as
either:

- a follow-up "🔒 Previous response was retracted by policy" notice
  in the same chat thread, or
- an in-place edit of the previously delivered assistant bubble that
  replaces the original text with the policy stub

The async hook can fire all it wants; the user sees no difference.

**Status:** the `HOOK_ASYNC_BLOCK` trigger and both async demo handlers
(`before_agent_run` mode: "async" and `llm_output` mode: "async") were
removed from `extensions/hook-echo/index.ts` to keep the manual smoke
test surface honest. The runner contract is preserved; only the
diagnostic plugin's exercise of it was removed.

**Fix shape:** define a chat event payload for "async intervention
received" (e.g., `state: "intervention"` with `pluginId`, `targetRunId`,
`decision`), have the runner emit it when an async hook calls
`controller.intervene`, and add SPA rendering for it. Two reasonable
designs:

1. **Append a follow-up assistant bubble** styled as an intervention
   banner. Cheap, keeps original text visible.
2. **Edit the prior assistant bubble in place**, scrubbing the
   original text from the persisted transcript. Stronger guarantee
   for moderation use cases.

Either path also needs a story for "what if the original message has
already been consumed by a downstream channel" (Slack, Telegram,
WhatsApp). Some channels support edit/delete; others do not.

Estimated cost (intervention-renders-in-SPA only): ~3-4 hours.
Estimated cost (intervention-also-edits-channel-side): per-channel
implementation, much larger.

---

## Bottom line

Four hook decisions — `HOOK_BLOCK_TOOL_OUTPUT`, `HOOK_ASK_TOOL_OUTPUT`,
`HOOK_ASK_OUTPUT`, and any `mode: "async"` `controller.intervene` —
all share the same upstream cause: openclaw never
plugged into `pi-coding-agent`'s `_extensionRunner` so it cannot
participate in the awaited per-event SDK seams that would let it
substitute, redact, or pause around individual messages and tool
results.

The fix for all three is the same: a one-time investment in an
openclaw-owned extension runner that pi-coding-agent's
`bindExtensions(...)` accepts. Estimated 5-8 hours, includes:

- Implementing the runner contract (lifecycle, commands, tool_call,
  tool_result, message_end, etc. — many members, not all needed at
  once but all need stub coverage)
- Routing `after_tool_call` and `llm_output` openclaw hooks through
  the runner's `emitToolResult` and (to-be-added) `emitMessageEnd`
- Reverting the post-prompt() ASK fallback in `attempt.ts:2778` to
  use the same path
- E2E coverage for "tool result is the substituted value, not the
  raw value" and "ASK actually pauses before tool dispatch"

Until that work happens, the available hooks for output gating are:

- `before_tool_call` ASK / BLOCK — works, gates tool dispatch via
  SDK's awaited `beforeToolCall`
- `llm_output` BLOCK (no retry) — works, aborts the session at
  message_end
- `llm_output` BLOCK + retry (HOOK_BLOCK_RETRY) — works, see retry
  fixes from this same branch
- `llm_output` REDACT — works at the renderer; the model sees the
  real text on next turn (same caveat as TOOL_OUTPUT_BLOCK)

The following do NOT work and should not be exposed in the public
hook taxonomy until the runner refactor lands:

- `after_tool_call` ASK / BLOCK with intent to gate the model
  (only renderer-level effects today; ripped in this branch)
- `llm_output` ASK on tool-using turns (ripped in this branch)
- `mode: "async"` `controller.intervene` for any hook point (no SPA
  seam consumes the intervention; runner contract preserved but the
  hook-echo exercise of it was removed in this branch)

## Implementation backlog (in rough priority order)

1. **Extension-runner shim for openclaw plugins.** Unblocks #2 and #3
   below by giving us awaited per-event hooks at the SDK boundary.
2. **`after_tool_call` substitution path.** Restores
   `HOOK_BLOCK_TOOL_OUTPUT` and `HOOK_ASK_TOOL_OUTPUT` properly.
3. **`llm_output` ASK with proper pause.** Restores `HOOK_ASK_OUTPUT`
   for both text-only and tool-using turns.
4. **Async-intervention SPA seam.** Add `state: "intervention"` chat
   event and SPA rendering so async hooks can actually surface their
   decisions to the user. Pick "append banner" or "edit in place" per
   product taste.
5. **Channel-side async edit/delete.** Per-channel work to mirror
   in-place async retractions to Slack/Telegram/WhatsApp/iMessage.
   Largest scope; only needed if (4) chooses the edit-in-place model.
