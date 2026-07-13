import { NextResponse } from "next/server";
import { getTask, getProject, updateTask, listMessages, addMessage, addSummary, clearPendingMessages } from "@/lib/store";
import { summarizeTranscript } from "@/lib/agents/oneshots";
import { hasTurn, abortTurn } from "@/lib/abort";
import { publish } from "@/lib/events";
import { buildClippedTranscript } from "@/lib/transcript";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  const project = getProject(task.project_id);
  if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });

  const gen = task.generation;

  // Stop any turn still streaming before we end this generation. /clear starts a
  // fresh context, so the running turn's work belongs to the OLD generation and
  // must not bleed into the new one. Aborting trips the runner's unwind; the
  // generation bump below — combined with the runner's generation-guarded settle
  // (lib/runner.ts) — stops that turn's finally from resurrecting the session id
  // this route nulls. We don't block on the turn fully settling: whichever order
  // the abort's finally and this write land in, the guard keeps session_id null.
  if (hasTurn(id)) abortTurn(id);

  // Build a transcript from the current generation's messages, clipping each
  // message and capping the total so an oversized session (a giant paste, or a
  // conversation that hit the context limit) can still be summarized —
  // otherwise summarizeTranscript would itself fail "prompt is too long" and
  // the handoff summary would be lost.
  const transcript = buildClippedTranscript(
    listMessages(id).filter(
      (m) => m.generation === gen && (m.role === "user" || m.role === "assistant" || m.role === "tool")
    )
  );

  let summary = "(empty session — nothing to summarize)";
  if (transcript.trim()) {
    try {
      summary = await summarizeTranscript(task, transcript, project);
    } catch (err) {
      summary = `(summary failed: ${err instanceof Error ? err.message : String(err)})`;
    }
  }

  addSummary(id, gen, summary);
  // Record the boundary + summary in the message log for continuity in the UI.
  addMessage(id, gen, "session_break", summary);

  // Fresh generation: new context window, session reset. started=0 so the next
  // send re-issues title+description, and buildProjectContext now includes the summary.
  const next = updateTask(id, {
    generation: gen + 1,
    session_id: null,
    started: 0,
    running: 0,
    awaiting_input: 0,
    status: "in_progress",
  });

  // Discard any follow-ups queued against the OLD generation. They were lined up
  // behind the context the user just cleared, so auto-draining them into the
  // fresh session would replay stale intent. (The aborted turn's finally also
  // clears the queue on its own path; doing it here too covers the no-turn case
  // and any residual rows, and is idempotent.)
  for (const p of clearPendingMessages(id)) publish(id, { type: "dequeued", msgId: p.id });

  return NextResponse.json({ task: next, summary, generation: gen + 1 });
}
