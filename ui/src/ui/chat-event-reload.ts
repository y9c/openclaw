import type { ChatEventPayload } from "./controllers/chat.ts";

export function shouldReloadHistoryForFinalEvent(payload?: ChatEventPayload): boolean {
  // Reload on both `final` and `error` because hook-block paths emit `error`
  // (with `errorKind: "hook_block"`) and the runner persists the policy
  // replacement message to disk; the SPA must refetch history so the assistant
  // bubble shows the block warning instead of the streamed (now-redacted)
  // text or an empty bubble.
  return Boolean(payload && (payload.state === "final" || payload.state === "error"));
}
