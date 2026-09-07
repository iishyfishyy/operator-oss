// The user's ask answers phrased as a chat reply.
//
// The normal delivery of an answer is in-process: the parked turn takes it as
// the tool result (lib/asks.ts → the driver's hook). When the turn that asked
// is gone — a Stop while parked, a server restart (the registry is in-memory),
// the hook timing out — the answers instead RESUME the session as an ordinary
// user message, and this is its text. Pure and dependency-free so both the
// /answer route (which persists it as the user bubble) and the client's legacy
// path (a card persisted before ask-id tracking) produce identical wording.
import type { AskQuestion, AskAnswers } from "./types";

export function formatAnswersReply(questions: AskQuestion[], answers: AskAnswers): string {
  const lines = questions.map((q, i) => {
    const picked = (answers[i] ?? []).filter((s) => s && s.trim());
    return `- ${q.header || q.question}: ${picked.length ? picked.join(", ") : "(no selection)"}`;
  });
  return `Answering your question${questions.length > 1 ? "s" : ""}:\n${lines.join("\n")}`;
}
