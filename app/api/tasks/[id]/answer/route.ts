import { getTask, getProject, answerAskMessage } from "@/lib/store";
import { submitAnswer } from "@/lib/asks";
import { startResumeTurn } from "@/lib/runner";
import { publish } from "@/lib/events";
import { formatAnswersReply } from "@/lib/askFormat";
import type { AskAnswers, AskQuestion } from "@/lib/types";

export const dynamic = "force-dynamic";

// Deliver the user's answer to an AskUserQuestion card.
// `resolved: true`  → the live turn was parked on it and continues in its own
//   stream (the runner publishes ask_answered once the driver takes the answer).
// `resolved: false, resumed: true` → nothing was parked under that id: the turn
//   that asked is gone (Stop while parked, a server restart — the ask registry
//   is in-memory — or the hook timed out) and the card was still sitting in the
//   transcript unanswered. The route settles it server-side and resumes the
//   session with the answers as an ordinary reply. Both writes land BEFORE the
//   ask_answered publish (persist-then-publish): the card carries its answers
//   and startResumeTurn has already flipped the row to running=1 /
//   awaiting_input=0, so the global /api/events snapshot for ask_answered reads
//   "working again" and unselected tasks agree with the open transcript. Leaving
//   the card unanswered in the DB (the old client-only fallback) made every
//   reload re-render it answerable and hid the progress dots for good.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });

  const { askId, answers, questions } = (await req.json()) as { askId?: string; answers?: AskAnswers; questions?: AskQuestion[] };
  if (!askId || !Array.isArray(answers)) {
    return new Response(JSON.stringify({ error: "askId and answers are required" }), { status: 400 });
  }

  if (submitAnswer(id, askId, answers)) return Response.json({ resolved: true, resumed: false });

  const project = getProject(task.project_id);
  if (!project) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  const card = answerAskMessage(id, askId, answers);
  // The persisted card knows its questions; a card-less answer (the id never
  // made it to the transcript) falls back to what the client rendered.
  const qs = card?.questions ?? (Array.isArray(questions) ? questions : []);
  await startResumeTurn(task, project, formatAnswersReply(qs, answers));
  if (card) {
    publish(id, { type: "ask_answered", id: askId, answers, msgId: card.message.id, generation: card.message.generation, awaiting_input: false });
  }
  return Response.json({ resolved: false, resumed: true });
}
