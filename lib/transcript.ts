// Building a summarizable transcript from a task's message log.
//
// After an oversized session (a giant paste, or a long conversation that ran
// into the context limit), the raw transcript can be many MB — so feeding it
// verbatim to summarizeTranscript() would itself hit "prompt is too long",
// leaving /clear with no handoff summary. buildClippedTranscript keeps the
// transcript small enough to summarize while preserving what matters: the
// head + tail of each message (a paste's opening and closing lines are the
// informative bits) and the most recent messages overall (the tail carries
// the freshest context for the summary).

export interface TranscriptMsg {
  role: string;
  content: string;
}

const CLIP_MARK = (n: number) => `\n… [${n.toLocaleString("en-US")} chars clipped] …\n`;

/** Clip one message's content to at most `max` chars, keeping the head and a
 *  short tail so both ends of a big paste survive. */
export function clipMessage(content: string, max: number): string {
  if (content.length <= max) return content;
  const tail = Math.min(500, Math.floor(max / 8));
  const head = max - tail;
  const dropped = content.length - head - tail;
  return content.slice(0, head) + CLIP_MARK(dropped) + content.slice(content.length - tail);
}

/**
 * Render messages as a `ROLE: content` transcript, clipping each message to
 * `perMessageMax` chars and capping the whole thing at `totalMax` by dropping
 * the OLDEST messages (a leading "(earlier messages omitted)" note flags it).
 * Pure + deterministic so it can be unit-tested without the SDK.
 */
export function buildClippedTranscript(
  msgs: TranscriptMsg[],
  perMessageMax = 4_000,
  totalMax = 150_000
): string {
  const lines = msgs.map((m) => `${m.role.toUpperCase()}: ${clipMessage(m.content, perMessageMax)}`);
  // Keep the most recent messages: walk from the end, adding lines until the
  // running length would exceed the cap.
  const kept: string[] = [];
  let used = 0;
  const SEP = "\n\n";
  for (let i = lines.length - 1; i >= 0; i--) {
    const add = lines[i].length + (kept.length ? SEP.length : 0);
    if (used + add > totalMax && kept.length) break;
    kept.unshift(lines[i]);
    used += add;
  }
  const omitted = lines.length - kept.length;
  const body = kept.join(SEP);
  return omitted > 0 ? `(${omitted} earlier message${omitted === 1 ? "" : "s"} omitted)\n\n${body}` : body;
}
