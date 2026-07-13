// Guards + recovery constants for the "Prompt is too long" failure mode.
//
// A giant paste used to permanently poison a task: the SDK reports the API's
// "prompt is too long" error as a soft stream error AFTER the session has
// already opened, so lib/runner.ts persists the session id anyway and every
// later message resumes the same over-limit session — the error repeats
// forever. These shared limits let the composer defuse big pastes up front
// (attach as a file instead of inlining), the messages route reject anything
// that slips through, and the runner recognize the error to surface a
// one-click recovery. Kept dependency-free so both server and client bundles
// can import it.

/** Client: a text paste larger than this becomes a `.txt` attachment instead
 *  of being inlined into the message (see app/orchestrator/Composer.tsx). */
export const PASTE_ATTACH_THRESHOLD = 100_000; // ~100 KB

/** Server: hard cap on a single message's characters (POST /messages). Big
 *  content should ride as an attachment, whose bytes never enter the prompt. */
export const MAX_MESSAGE_CHARS = 262_144; // 256 KB

// Each provider phrases a context-window overflow differently, and the recovery
// flow ("Start fresh context") is agent-agnostic, so we match every driver's
// signature here:
//   - Anthropic (Claude driver): "prompt is too long: N tokens > M maximum".
//   - OpenAI/Codex (Codex driver): the API returns "context_length_exceeded"
//     with a message like "maximum context length is N tokens. However, your
//     messages resulted in M tokens" / "reduce the length of the messages".
//     The codex CLI surfaces the same as an "exceeds the context window" / "input
//     is too long" turn failure. Any of these should trip the same recovery.
const CONTEXT_OVERFLOW_RES = [
  /prompt is too long/i,
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /exceeds? the (?:model'?s? )?context (?:window|length|limit)/i,
  /(?:input|conversation|message)s? (?:is |are )?too long/i,
  /reduce the length of the messages/i,
];

/** True when an error/stream message is a provider's context-overflow rejection
 *  (Anthropic "prompt is too long", OpenAI/Codex "context_length_exceeded", …). */
export function isPromptTooLong(msg: string | null | undefined): boolean {
  return !!msg && CONTEXT_OVERFLOW_RES.some((re) => re.test(msg));
}

/** Appended to the persisted error line when a turn overflows the context
 *  window. The UI (app/orchestrator/Transcript.tsx) matches this exact string
 *  to render the "Start fresh context" recovery button. Persisted message
 *  content is the durable channel — it survives SSE reconnects because the
 *  snapshot replays messages from SQLite. */
export const CONTEXT_OVERFLOW_NOTICE =
  "This session's context exceeds the model's limit, so it can't continue. " +
  "Start a fresh context window to keep going — a summary of this session carries over.";
