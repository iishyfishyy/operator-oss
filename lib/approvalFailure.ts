// Detection + recovery constants for the "Codex's approval policy blocked the
// turn" failure mode.
//
// Operator runs Codex through `codex exec` (via @openai/codex-sdk), which is
// non-interactive: nobody can answer a command-approval prompt mid-turn. So the
// driver asks for `approval_policy=never` (the auto-run analog of Claude's
// bypassPermissions). Two configurations defeat that and produce the same
// baffling failure:
//
//   1. Enterprise-managed Codex requirements disallow `never`. The CLI warns
//      ("Configured value for `approval_policy` is disallowed by requirements;
//      falling back to required value UnlessTrusted") and silently downgrades.
//      Under UnlessTrusted every non-allowlisted command needs an approval that
//      exec mode cannot service — codex_core rejects each one ("approval
//      request failed"), and the agent flails through its tools with no
//      explanation.
//   2. The user's own ~/.codex/config.toml sets an approval-requiring policy
//      and Operator runs with CODEX_APPROVAL_POLICY=inherit.
//
// The downgrade warning arrives as an error item on the very first affected
// turn (lib/agents/codex/events.ts maps it to a StreamEvent error), so the
// Codex driver matches it there and flips an instance-wide flag that makes it
// request the exec-compatible "on-request" policy from the next turn on
// (self-healing, no user action). This module classifies the failure for
// lib/runner.ts — same pattern as lib/promptLimits.ts / lib/authFailure.ts —
// which appends APPROVAL_BLOCKED_NOTICE so the UI can render a one-click Retry.
// Kept dependency-free so both server and client bundles can import it.

/** The CLI's managed-requirements downgrade warning — the signal that the
 *  approval policy Operator asked for was rejected and a stricter one applies.
 *  Matched by the Codex driver to trigger auto-negotiation. */
const APPROVAL_DOWNGRADE_RES = [
  /approval_policy[^\n]{0,80}disallowed by requirements/i,
  /disallowed by requirements[^\n]{0,120}approval_policy/i,
  /invalid value for [`'"]?approval_policy[`'"]?[^\n]{0,80}not in the allowed set/i,
];

/** True when an error is the CLI's "your approval_policy was rejected by
 *  managed requirements, falling back to a stricter value" warning. */
export function isApprovalDowngrade(msg: string | null | undefined): boolean {
  return !!msg && APPROVAL_DOWNGRADE_RES.some((re) => re.test(msg));
}

// The rejections codex_core emits when an approval-requiring policy meets exec
// mode's inability to ask anyone:
//   - "command execution approval is not supported in exec mode for thread …"
//   - "exec_command failed …: Rejected(\"approval request failed\")"
//   - "approval policy is UnlessTrusted; reject command — you cannot ask for
//     escalated permissions if the approval policy is UnlessTrusted"
const APPROVAL_BLOCKED_RES = [
  ...APPROVAL_DOWNGRADE_RES,
  /approval request failed/i,
  /approval policy is \w+; reject/i,
  /(?:command execution )?approval is not supported in exec mode/i,
  /cannot ask for escalated permissions/i,
];

/** True when a turn's error text is an approval-policy rejection (the managed
 *  downgrade warning, or exec mode failing to service an approval) rather than
 *  a work failure. */
export function isApprovalBlocked(msg: string | null | undefined): boolean {
  return !!msg && APPROVAL_BLOCKED_RES.some((re) => re.test(msg));
}

/** Appended to the persisted error line when a turn is blocked by the approval
 *  policy. The UI (app/orchestrator/Transcript.tsx) matches this exact string
 *  to render the "Retry" button — the driver has already switched future turns
 *  to the exec-compatible "on-request" policy by the time anyone reads this, so
 *  resending the same message is the recovery. Persisted message content is the
 *  durable channel — it survives SSE reconnects because the snapshot replays
 *  from SQLite. */
export const APPROVAL_BLOCKED_NOTICE =
  "The agent's approval policy blocked this turn: it requires interactive command approval, which " +
  "Operator's unattended sessions can't provide. Operator now requests the compatible 'on-request' " +
  "policy for its Codex sessions, so retrying the message should go through. (Running with " +
  "CODEX_APPROVAL_POLICY=inherit? Set an exec-compatible approval_policy, e.g. \"on-request\", in " +
  "~/.codex/config.toml instead.)";
