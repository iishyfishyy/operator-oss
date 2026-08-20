// Detection + recovery constants for the "your agent login stopped working"
// failure mode.
//
// An expired OAuth session is invisible until you send a turn, and then it looks
// like a code problem: the raw provider string ("Failed to authenticate: OAuth
// session expired and could not be refreshed") lands in ONE task's transcript,
// while every other task on the instance is equally dead — same CLI, same
// credentials on disk. Worse, each queued follow-up would dequeue and fail the
// same way, emptying the queue for nothing.
//
// So an auth failure is classified here (agent-agnostically — Codex phrases it
// differently and fails identically), which lets lib/runner.ts append
// AUTH_EXPIRED_NOTICE for a one-click reconnect, park the queue instead of
// burning it, and flag the agent instance-wide (lib/agents/connections.ts) so
// the app can say so in the titlebar rather than only inside the task that
// happened to run first. Kept dependency-free so both server and client bundles
// can import it (same rule as lib/promptLimits.ts).

// Each agent CLI/SDK words a dead credential differently, and the recovery
// ("reconnect this agent") is identical for all of them:
//   - Claude Code:  "Failed to authenticate: OAuth session expired and could
//     not be refreshed"; API-key path: "invalid x-api-key" / 401.
//   - Codex: "not logged in", "please run codex login", "401 Unauthorized".
//   - Either provider's raw HTTP rejection: 401 + authentication_error.
// The 401/403 patterns require a nearby auth word so an unrelated error that
// merely contains a status code can't trip the banner.
const AUTH_FAILURE_RES = [
  /failed to authenticate/i,
  /authentication (?:failed|error|required)/i,
  /could not be refreshed/i,
  /(?:oauth|login|access|refresh) (?:session|token)[^.\n]{0,40}(?:expired|revoked|invalid|refresh)/i,
  /(?:session|token|credentials?)[^.\n]{0,30}(?:has |have |is |are )?(?:expired|revoked)/i,
  /invalid[_ ]grant/i,
  /invalid[^.\n]{0,20}(?:api[- ]?key|x-api-key|credentials?|token)/i,
  /(?:api[- ]?key|credentials?)[^.\n]{0,30}(?:invalid|expired|revoked|missing|not found)/i,
  /\bnot (?:logged in|authenticated|signed in)\b/i,
  /(?:re-?authenticate|re-?login|log ?in again|sign ?in again)/i,
  /run [`'"]?(?:claude|codex)(?: auth)? login/i,
  /\b40[13]\b[^\n]{0,60}(?:unauthorized|forbidden|authentication|invalid|expired|api[- ]?key)/i,
  /(?:unauthorized|forbidden)[^\n]{0,40}\b40[13]\b/i,
  /unable to locate (?:aws )?credentials/i,
  /aws default-chain credential resolve (?:timed out|failed)/i,
  /(?:ExpiredToken|InvalidClientTokenId|UnrecognizedClientException)/i,
  /(?:aws|sso)[^.\n]{0,30}(?:credentials?|session|token)[^.\n]{0,30}(?:expired|invalid|missing)/i,
];

/** True when a turn's error text is a dead-credential rejection (expired OAuth
 *  session, revoked token, bad/missing API key) rather than a work failure. */
export function isAuthFailure(msg: string | null | undefined): boolean {
  return !!msg && AUTH_FAILURE_RES.some((re) => re.test(msg));
}

/** Appended to the persisted error line when a turn dies on authentication. The
 *  UI (app/orchestrator/Transcript.tsx) matches this exact string to render the
 *  "Reconnect" button, so it must stay agent-neutral — the client already knows
 *  the task's agent and labels the button with it. Persisted message content is
 *  the durable channel: it survives SSE reconnects because the snapshot replays
 *  from SQLite. */
export const AUTH_EXPIRED_NOTICE =
  "This agent's connection has stopped working — its credentials expired, were revoked, or are unavailable, " +
  "so no turn can run until you reconnect or refresh them. Nothing was lost: this session and its " +
  "worktree are untouched, and any queued messages stay queued.";

/** The one-line, instance-wide version of the same news, for the titlebar banner
 *  (app/orchestrator/AgentConnect.tsx → AgentAuthBanner). */
export const AUTH_BANNER_HINT = "No session can run until its credentials are refreshed.";
