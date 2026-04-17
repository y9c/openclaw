/**
 * Hook Decision Types — Milestone 0
 *
 * Structured decision contract for gate/policy hooks.
 * Core is outcome-agnostic — it handles the mechanics of each outcome
 * without knowing *why* the decision was made.
 *
 * Any plugin can return a HookDecision from any gate hook for any purpose:
 * moderation, PII scrubbing, cost gates, compliance, etc.
 */

// ---------------------------------------------------------------------------
// HookDecision — the core discriminated union
// ---------------------------------------------------------------------------

/**
 * Structured decision returned by gate/policy hooks.
 * Core is outcome-agnostic — it handles the mechanics of each outcome
 * without knowing *why* the decision was made.
 */
export type HookDecision =
  | HookDecisionPass
  | HookDecisionBlock
  | HookDecisionRedact
  | HookDecisionAsk;

/** Content is fine. Proceed normally. */
export type HookDecisionPass = {
  outcome: "pass";
};

/**
 * Content is blocked. Do not proceed.
 * Core will prevent execution and surface the `userMessage` to the user.
 * `reason` is internal (logged, not shown). `userMessage` is user-facing.
 */
export type HookDecisionBlock = {
  outcome: "block";
  /** Internal reason for logging/observability. Never shown to user. */
  reason: string;
  /** Message shown to the user. Should be helpful, not scary. */
  userMessage?: string;
  /** Plugin-defined category for analytics (e.g. "violence", "pii", "cost_limit"). */
  category?: string;
  /** Opaque metadata for the plugin's own use. Core persists but doesn't interpret. */
  metadata?: Record<string, unknown>;
};

/**
 * Content should be redacted. The pipeline may have already executed
 * (e.g. a streamed response), so core will retroactively scrub.
 */
export type HookDecisionRedact = {
  outcome: "redact";
  reason: string;
  /** Message to replace the redacted content with, if any. */
  replacementMessage?: string;
  category?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Content requires human approval before proceeding.
 * The pipeline pauses and an approval prompt is shown to the owner.
 * If denied (or on timeout with deny behavior), treated as block.
 */
export type HookDecisionAsk = {
  outcome: "ask";
  /** Internal reason for logging/observability. Never shown to user. */
  reason: string;
  /** Title shown in the approval prompt. Should be short and clear. */
  title: string;
  /** Description shown in the approval prompt. */
  description: string;
  /** Visual severity hint for the UI. Default: "warning". */
  severity?: "info" | "warning" | "critical";
  /** How long to wait for user response in ms. Default: 120000. Max: 600000. */
  timeoutMs?: number;
  /** What happens on timeout. Default: "deny". */
  timeoutBehavior?: "allow" | "deny";
  /** Message shown to the user if denied. Only meaningful for output gates. */
  denialMessage?: string;
  /** Plugin-defined category for analytics. */
  category?: string;
  /** Opaque metadata for the plugin's own use. Core persists but doesn't interpret. */
  metadata?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Decision outcome priority for merging (most-restrictive-wins)
// ---------------------------------------------------------------------------

/** Outcome severity for most-restrictive-wins merging. Higher = more restrictive. */
export const HOOK_DECISION_SEVERITY: Record<HookDecision["outcome"], number> = {
  pass: 0,
  ask: 1,
  block: 2,
  redact: 3,
};

/**
 * Merge two HookDecisions using most-restrictive-wins semantics.
 * `redact > block > ask > pass`
 */
export function mergeHookDecisions(a: HookDecision | undefined, b: HookDecision): HookDecision {
  if (!a) {
    return b;
  }
  return HOOK_DECISION_SEVERITY[b.outcome] > HOOK_DECISION_SEVERITY[a.outcome] ? b : a;
}

/**
 * Type guard: does this object look like a HookDecision (has `outcome` field)?
 */
export function isHookDecision(value: unknown): value is HookDecision {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    v.outcome === "pass" || v.outcome === "block" || v.outcome === "redact" || v.outcome === "ask"
  );
}

// ---------------------------------------------------------------------------
// Phase-restricted decision types
// ---------------------------------------------------------------------------

/** Outcomes valid for input gates (before_agent_run). */
export type InputGateDecision = HookDecisionPass | HookDecisionBlock | HookDecisionAsk;

/** Outcomes valid for output gates (llm_output, after_tool_call). */
export type OutputGateDecision = HookDecision; // all four are valid

// ---------------------------------------------------------------------------
// Hook Decision Event (observability)
// ---------------------------------------------------------------------------

/**
 * Core-emitted event whenever a gate hook returns a non-pass HookDecision.
 * Not moderation-specific — fires for any plugin, for any reason.
 */
export type HookDecisionEvent = {
  timestamp: number;
  hookPoint: string;
  pluginId: string;
  decision: HookDecision;
  sessionKey: string;
  sessionId?: string;
  runId?: string;
  channelId?: string;
  senderId?: string;
  /** Duration of the hook handler execution. */
  hookDurationMs: number;
  /** Whether channel retraction was attempted and succeeded (redact only). */
  channelRetractionResult?: "success" | "fallback" | "not_attempted";
};

// ---------------------------------------------------------------------------
// HookController — async intervention handle
// ---------------------------------------------------------------------------

/**
 * Controller for async (non-blocking) hook handlers.
 * Allows retroactive intervention in the running pipeline.
 *
 * intervene() ALWAYS performs all steps (no branching on pipeline state):
 * 1. Abort the stream (if running) or prevent start
 * 2. Redact any persisted content from the session transcript
 * 3. Best-effort channel retraction (delete/edit delivered messages)
 * 4. Surface replacement message to the user
 */
export type HookController = {
  /** Aborted when the intervention window closes (timeout or pipeline cleanup). */
  signal: AbortSignal;
  /** Intervene in the running pipeline. Always stops + redacts. */
  intervene(decision: HookDecision): void;
};

// ---------------------------------------------------------------------------
// Redaction audit entry
// ---------------------------------------------------------------------------

/**
 * Entry written to the per-session redaction audit log.
 * Contains hashes, not content (the redacted content is gone forever).
 */
export type RedactionAuditEntry = {
  /** Timestamp of the redaction. */
  ts: number;
  /** The hook point that triggered the redaction. */
  hookPoint: string;
  /** Which plugin requested the redaction. */
  pluginId: string;
  /** Internal reason for the redaction. */
  reason: string;
  /** Plugin-defined category. */
  category?: string;
  /** SHA-256 hash of the redacted content (not the content itself). */
  contentHash?: string;
  /** Number of messages removed from the transcript. */
  messagesRemoved: number;
};
