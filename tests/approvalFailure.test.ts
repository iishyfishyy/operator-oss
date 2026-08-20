import { describe, expect, it } from "vitest";
import { isApprovalBlocked, isApprovalDowngrade, APPROVAL_BLOCKED_NOTICE } from "@/lib/approvalFailure";
import { isAuthFailure } from "@/lib/authFailure";
import { isPromptTooLong } from "@/lib/promptLimits";
import { isUsageLimit } from "@/lib/usageLimit";

// Real CLI wordings, captured from codex 2026-08 against an enterprise-managed
// config that disallows approval_policy=never (see lib/approvalFailure.ts).
const DOWNGRADE =
  "Configured value for `approval_policy` is disallowed by requirements; falling back to required value " +
  "UnlessTrusted. Details: invalid value for `approval_policy`: `Never` is not in the allowed set " +
  "[UnlessTrusted, OnRequest, Granular(GranularApprovalConfig { sandbox_approval: true, rules: true, " +
  "skill_approval: true, request_permissions: true, mcp_elicitations: true })] (set by enterprise-managed " +
  "requirements All users (93155247-b78f-4910-a06e-e1ed3c113a34))";

const EXEC_REJECTIONS = [
  'command execution approval is not supported in exec mode for thread 019ff714-aaaa-bbbb-cccc-dddddddddddd',
  'exec_command failed for session 1: Rejected("approval request failed")',
  "approval policy is UnlessTrusted; reject command — you cannot ask for escalated permissions if the " +
    "approval policy is UnlessTrusted",
];

describe("isApprovalDowngrade", () => {
  it("matches the CLI's managed-requirements downgrade warning", () => {
    expect(isApprovalDowngrade(DOWNGRADE)).toBe(true);
  });

  it("does not match the runtime exec rejections (those don't imply a downgrade happened)", () => {
    for (const msg of EXEC_REJECTIONS) expect(isApprovalDowngrade(msg)).toBe(false);
  });

  it("does not match ordinary errors", () => {
    expect(isApprovalDowngrade("Run ended: model_error")).toBe(false);
    expect(isApprovalDowngrade(null)).toBe(false);
  });
});

describe("isApprovalBlocked", () => {
  it("matches the downgrade warning and every exec rejection wording", () => {
    expect(isApprovalBlocked(DOWNGRADE)).toBe(true);
    for (const msg of EXEC_REJECTIONS) expect(isApprovalBlocked(msg)).toBe(true);
  });

  it("does not match ordinary work failures", () => {
    for (const msg of [
      "Run ended: model_error",
      "Command failed with exit code 1",
      "npm ERR! approval-tool@1.0.0 build: tsc",
      "prompt is too long: 250000 tokens > 200000 maximum",
    ]) {
      expect(isApprovalBlocked(msg)).toBe(false);
    }
  });

  // publishTurnError picks exactly one notice per failure; the earlier
  // classifiers must not steal these signatures (nor this one steal theirs).
  it("stays disjoint from the other recoverable-failure classifiers", () => {
    for (const msg of [DOWNGRADE, ...EXEC_REJECTIONS]) {
      expect(isAuthFailure(msg)).toBe(false);
      expect(isPromptTooLong(msg)).toBe(false);
      expect(isUsageLimit(msg)).toBe(false);
    }
  });
});

describe("APPROVAL_BLOCKED_NOTICE", () => {
  it("is non-empty and mentions the recovery knobs", () => {
    expect(APPROVAL_BLOCKED_NOTICE).toContain("on-request");
    expect(APPROVAL_BLOCKED_NOTICE).toContain("CODEX_APPROVAL_POLICY");
  });
});
