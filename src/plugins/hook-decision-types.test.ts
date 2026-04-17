import { describe, expect, it } from "vitest";
import {
  type HookDecision,
  mergeHookDecisions,
  isHookDecision,
  HOOK_DECISION_SEVERITY,
} from "./hook-decision-types.js";

describe("HookDecision types", () => {
  describe("isHookDecision", () => {
    it("recognizes pass", () => {
      expect(isHookDecision({ outcome: "pass" })).toBe(true);
    });

    it("recognizes block", () => {
      expect(isHookDecision({ outcome: "block", reason: "test" })).toBe(true);
    });

    it("recognizes redact", () => {
      expect(isHookDecision({ outcome: "redact", reason: "r" })).toBe(true);
    });

    it("rejects null", () => {
      expect(isHookDecision(null)).toBe(false);
    });

    it("rejects undefined", () => {
      expect(isHookDecision(undefined)).toBe(false);
    });

    it("rejects strings", () => {
      expect(isHookDecision("pass")).toBe(false);
    });

    it("rejects objects without outcome", () => {
      expect(isHookDecision({ block: true })).toBe(false);
    });

    it("rejects objects with invalid outcome", () => {
      expect(isHookDecision({ outcome: "invalid" })).toBe(false);
    });
  });

  describe("HOOK_DECISION_SEVERITY", () => {
    it("pass is least restrictive", () => {
      expect(HOOK_DECISION_SEVERITY.pass).toBe(0);
    });

    it("severity order is pass < block < redact", () => {
      expect(HOOK_DECISION_SEVERITY.pass).toBeLessThan(HOOK_DECISION_SEVERITY.block);
      expect(HOOK_DECISION_SEVERITY.block).toBeLessThan(HOOK_DECISION_SEVERITY.redact);
    });
  });

  describe("mergeHookDecisions", () => {
    it("returns b when a is undefined", () => {
      const b: HookDecision = { outcome: "pass" };
      expect(mergeHookDecisions(undefined, b)).toBe(b);
    });

    it("keeps pass when both are pass", () => {
      const a: HookDecision = { outcome: "pass" };
      const b: HookDecision = { outcome: "pass" };
      expect(mergeHookDecisions(a, b)).toBe(a);
    });

    it("escalates pass → block", () => {
      const a: HookDecision = { outcome: "pass" };
      const b: HookDecision = { outcome: "block", reason: "test" };
      expect(mergeHookDecisions(a, b)).toBe(b);
    });

    it("escalates block → redact", () => {
      const a: HookDecision = { outcome: "block", reason: "b" };
      const b: HookDecision = { outcome: "redact", reason: "r" };
      expect(mergeHookDecisions(a, b)).toBe(b);
    });

    it("does not downgrade redact → block", () => {
      const a: HookDecision = { outcome: "redact", reason: "r" };
      const b: HookDecision = { outcome: "block", reason: "b" };
      expect(mergeHookDecisions(a, b)).toBe(a);
    });

    it("does not downgrade redact → pass", () => {
      const a: HookDecision = { outcome: "redact", reason: "r" };
      const b: HookDecision = { outcome: "pass" };
      expect(mergeHookDecisions(a, b)).toBe(a);
    });
  });
});
