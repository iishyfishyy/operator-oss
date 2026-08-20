import { afterAll, describe, expect, it } from "vitest";
import { approvalOverride, noteApprovalDowngrade } from "@/lib/agents/codex/driver";
import { setSetting } from "@/lib/store";

// Approval-policy auto-negotiation (lib/agents/codex/driver.ts): the driver
// asks for "never" by default; when an enterprise-managed Codex config rejects
// it, the CLI's downgrade warning (surfaced as a StreamEvent error on the first
// affected turn) flips a persisted instance-wide flag, and every later turn
// requests the exec-compatible "on-request" instead. Tests run in file order on
// the shared hermetic DB, so the flag is cleared at the end.

const DOWNGRADE =
  "Configured value for `approval_policy` is disallowed by requirements; falling back to required value UnlessTrusted.";

afterAll(() => setSetting("codex_approval_downgraded", null));

describe("codex approval-policy negotiation", () => {
  it("requests the configured policy (default never) before any downgrade is seen", () => {
    expect(approvalOverride()).toEqual({ approvalPolicy: "never" });
  });

  it("ignores errors that are not the downgrade warning", () => {
    noteApprovalDowngrade("Run ended: model_error");
    noteApprovalDowngrade('exec_command failed: Rejected("approval request failed")'); // symptom, not the downgrade signal
    expect(approvalOverride()).toEqual({ approvalPolicy: "never" });
  });

  it("switches to on-request once the CLI reports the managed downgrade, and stays there", () => {
    noteApprovalDowngrade(DOWNGRADE);
    expect(approvalOverride()).toEqual({ approvalPolicy: "on-request" });
    // Sticky across repeats — a second sighting must not reset or change it.
    noteApprovalDowngrade(DOWNGRADE);
    expect(approvalOverride()).toEqual({ approvalPolicy: "on-request" });
  });
});
