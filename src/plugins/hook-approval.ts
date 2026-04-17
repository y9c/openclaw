/**
 * Hook Approval — human-in-the-loop approval for gate hooks.
 *
 * Reuses the existing `plugin.approval.*` gateway RPC infrastructure
 * that powers `before_tool_call` → `requireApproval`.
 *
 * Gate hooks only support `allow-once` and `deny` (no `allow-always`
 * since prompts and outputs are freeform with no stable matching key).
 */

import { callGatewayTool } from "../agents/tools/gateway.js";
import type { HookDecisionAsk } from "./hook-decision-types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HookApprovalResult = "allow-once" | "deny" | "timeout" | "cancelled";

export type HookApprovalParams = {
  /** Which hook point is requesting approval. */
  hookPoint: string;
  /** The ask decision from the plugin. */
  decision: HookDecisionAsk;
  /** Plugin ID that returned the ask decision. */
  pluginId?: string;
  /** Current run ID. */
  runId?: string;
  /** Current session key. */
  sessionKey?: string;
  /** Current agent ID. */
  agentId?: string;
  /** Channel ID for delivery routing. */
  channelId?: string;
  /** Abort signal — cancelled if the run is aborted. */
  signal?: AbortSignal;
  /** Logger for warnings/errors. */
  log?: { warn: (msg: string) => void };
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Request human approval for a gate hook decision.
 *
 * Sends a `plugin.approval.request` to the gateway, waits for the user
 * to respond with allow-once or deny, and returns the result.
 *
 * On timeout, returns "timeout" — the caller decides behavior based on
 * `decision.timeoutBehavior`.
 */
export async function requestHookApproval(params: HookApprovalParams): Promise<HookApprovalResult> {
  const { decision, hookPoint, signal, log } = params;
  const timeoutMs = decision.timeoutMs ?? 120_000;

  try {
    // Phase 1: Create the approval request
    const requestResult: {
      id?: string;
      status?: string;
      decision?: string | null;
    } = await callGatewayTool(
      "plugin.approval.request",
      // Buffer beyond the approval timeout so the gateway can clean up
      // and respond before the client-side RPC timeout fires.
      { timeoutMs: timeoutMs + 10_000 },
      {
        pluginId: params.pluginId ?? `hook:${hookPoint}`,
        title: decision.title,
        description: decision.description,
        severity: decision.severity ?? "warning",
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        timeoutMs,
        twoPhase: true,
      },
      { expectFinal: false },
    );

    const id = requestResult?.id;
    if (!id) {
      log?.warn?.(`hook approval request failed (no id returned) for ${hookPoint}`);
      return "cancelled";
    }

    // Check for immediate decision (e.g. no approval route available)
    const hasImmediateDecision = Object.prototype.hasOwnProperty.call(
      requestResult ?? {},
      "decision",
    );

    let rawDecision: string | null | undefined;

    if (hasImmediateDecision) {
      rawDecision = requestResult.decision;
      if (rawDecision === null) {
        // No approval route available
        log?.warn?.(`hook approval unavailable (no approval route) for ${hookPoint}`);
        return "cancelled";
      }
    } else {
      // Phase 2: Wait for the decision
      const waitPromise: Promise<{
        id?: string;
        decision?: string | null;
      }> = callGatewayTool(
        "plugin.approval.waitDecision",
        { timeoutMs: timeoutMs + 10_000 },
        { id },
      );

      let waitResult: { id?: string; decision?: string | null } | undefined;

      if (signal) {
        // Race the wait against the abort signal
        let onAbort: (() => void) | undefined;
        const abortPromise = new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
          waitResult = await Promise.race([waitPromise, abortPromise]);
        } finally {
          if (onAbort) {
            signal.removeEventListener("abort", onAbort);
          }
        }
      } else {
        waitResult = await waitPromise;
      }

      rawDecision = waitResult?.decision;
    }

    return normalizeDecision(rawDecision);
  } catch (err) {
    if (isAbortCancellation(err, signal)) {
      log?.warn?.(`hook approval cancelled by run abort for ${hookPoint}: ${String(err)}`);
      return "cancelled";
    }
    log?.warn?.(
      `hook approval gateway request failed for ${hookPoint}, treating as cancelled: ${String(err)}`,
    );
    return "cancelled";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeDecision(raw: string | null | undefined): HookApprovalResult {
  if (raw === "allow-once") {
    return "allow-once";
  }
  if (raw === "deny") {
    return "deny";
  }
  // Gate hooks don't support allow-always — treat as allow-once
  if (raw === "allow-always") {
    return "allow-once";
  }
  return "timeout";
}

function isAbortCancellation(err: unknown, signal?: AbortSignal): boolean {
  if (!signal?.aborted) {
    return false;
  }
  if (err === signal.reason) {
    return true;
  }
  if (err instanceof DOMException && err.name === "AbortError") {
    return true;
  }
  return false;
}
