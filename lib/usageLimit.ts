// Detection + recovery constants for the "your subscription's usage limit is
// spent" failure mode.
//
// A subscription limit (Claude's 5-hour window, the weekly cap, an API 429)
// hits mid-run and looks like a code problem: the raw provider string ("Claude
// AI usage limit reached|1735689600") lands in ONE task's transcript with no
// hint that nothing is broken — the quota is simply spent and refills on its
// own. Worse, without classification the runner would treat it as an ordinary
// work failure and drain the pending queue: each queued follow-up would
// dequeue, run straight into the same dead quota, and fail identically,
// emptying the queue for nothing.
//
// So a usage-limit failure is classified here (agent-agnostically — a Codex
// quota phrases it differently and fails identically), which lets
// lib/runner.ts append USAGE_LIMIT_NOTICE and park the queue instead of
// burning it. Unlike the auth twin (lib/authFailure.ts) there is no button to
// click — the recovery is waiting for the reset — so the notice is purely
// informational, and the Claude driver enriches the error line with the
// machine-reported reset time when the SDK provided one. Kept dependency-free
// so both server and client bundles can import it (same rule as
// lib/promptLimits.ts).

// Each provider words a spent quota differently, and the recovery ("wait for
// the reset") is identical for all of them:
//   - Claude Code (subscription): "Claude AI usage limit reached|<epoch>";
//     the CLI's display forms "5-hour limit reached ∙ resets 3pm" and
//     "Weekly limit reached".
//   - Anthropic API: 429 rate_limit_error ("Number of request tokens has
//     exceeded your per-minute rate limit", "This request would exceed your
//     organization's rate limit").
//   - OpenAI/Codex: "You've hit your usage limit", 429 insufficient_quota
//     ("You exceeded your current quota").
// The generic patterns (429, "rate limit", "quota") require a nearby
// limit/exceeded word so an unrelated error that merely mentions a status
// code or the word "quota" can't trip the parking behavior.
const USAGE_LIMIT_RES = [
  /usage limit reached/i,
  /\b(?:5|five)[- ]hour limit/i,
  /\bweekly limit\b/i,
  /(?:usage|subscription|plan) limit[^.\n]{0,40}(?:reached|exceeded|hit)/i,
  /(?:reached|exceeded|hit)[^.\n]{0,30}(?:usage|subscription|plan|rate) limit/i,
  /rate[_ ]limit(?:_error|ed)?[^.\n]{0,40}(?:exceeded|reached|exhausted)/i,
  /(?:exceed|exceeded|exceeds)[^.\n]{0,40}rate[_ ]limit/i,
  /(?:exceeded|exhausted)[^.\n]{0,30}(?:your|current|the)[^.\n]{0,20}quota/i,
  /quota[^.\n]{0,30}(?:exceeded|exhausted|reached)/i,
  /insufficient[_ ]quota/i,
  /out of (?:usage|quota|credits)/i,
  /\b429\b[^\n]{0,60}(?:rate[_ ]limit|quota|usage limit|too many requests)/i,
  /too many requests[^\n]{0,40}\b429\b/i,
  /(?:ThrottlingException|TooManyRequestsException)/i,
  /(?:bedrock|aws)[^.\n]{0,40}(?:service quota|throttl)[^.\n]{0,40}(?:exceed|reached|exception)/i,
];

/** True when a turn's error text is a spent-quota rejection (Claude's 5-hour /
 *  weekly subscription limit, an API 429 rate limit) rather than a work
 *  failure. Checked AFTER isPromptTooLong and isAuthFailure in lib/runner.ts,
 *  so those classifiers keep first claim on their own signatures. */
export function isUsageLimit(msg: string | null | undefined): boolean {
  return !!msg && USAGE_LIMIT_RES.some((re) => re.test(msg));
}

/** Appended to the persisted error line when a turn dies on a spent usage
 *  limit. The UI (app/orchestrator/Transcript.tsx) matches this exact string
 *  to render the informational recovery hint — keep it stable. No action
 *  button: the quota refills on its own, so the recovery is waiting (the raw
 *  provider text above the notice carries the reset time when the SDK reported
 *  one). Persisted message content is the durable channel — it survives SSE
 *  reconnects because the snapshot replays from SQLite. */
export const USAGE_LIMIT_NOTICE =
  "This agent's usage limit has been reached, so no turn can run until the limit resets. " +
  "Nothing was lost: this session and its worktree are untouched, and any queued messages " +
  "stay queued — they run once the limit resets.";
