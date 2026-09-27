import { NextResponse } from "next/server";
import { getTask, getProject, updateTask, listMessages, addMessage, addSummary, clearPendingMessages, getTaskContext } from "@/lib/store";
import { getClearEstimate } from "@/lib/internalUsage";
import { summarizeTranscript } from "@/lib/agents/oneshots";
import { hasTurn, abortTurn } from "@/lib/abort";
import { publish, publishGlobal } from "@/lib/events";
import { buildClippedTranscript } from "@/lib/transcript";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ estimate: getClearEstimate(getTaskContext(id).context_tokens, task.agent) });
}

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

  // The summarize above can take minutes — re-read before writing. The task may
  // have been deleted while we waited (addSummary would then throw FOREIGN KEY
  // and 500), or another tab's /clear may have already advanced the generation
  // (bumping again here would skip a generation and double-record the boundary).
  const cur = getTask(id);
  if (!cur) return NextResponse.json({ error: "task was deleted while summarizing" }, { status: 404 });
  if (cur.generation !== gen) return NextResponse.json({ task: cur, summary, generation: cur.generation });

  addSummary(id, gen, summary);
  // Record the boundary + summary in the message log for continuity in the UI.
  addMessage(id, gen, "session_break", summary);

  // Fresh generation: new context window, session reset. started=0 so the next
  // send is treated as an opening turn — and because generation is now > 1 the
  // messages route opens it with buildResumePrompt ("you are continuing this
  // task"), not the kickoff the task got on day one. buildProjectContext
  // supplies the task metadata and now includes the summary, so the resume
  // turn itself doesn't repeat it.
  //
  // A finished auto-advance chain step (In review) STAYS In review: later
  // steps are already stacked on it and the chain review reads that status —
  // a /clear there is just a fresh context for follow-ups, not new work.
  const next = updateTask(id, {
    generation: gen + 1,
    session_id: null,
    started: 0,
    running: 0,
    awaiting_input: 0,
    step_pause: "",
    status: cur.chain_id && cur.status === "in_review" ? "in_review" : "in_progress",
  });

  // Discard any follow-ups queued against the OLD generation. They were lined up
  // behind the context the user just cleared, so auto-draining them into the
  // fresh session would replay stale intent. (The aborted turn's finally also
  // clears the queue on its own path; doing it here too covers the no-turn case
  // and any residual rows, and is idempotent.)
  for (const p of clearPendingMessages(id)) publish(id, { type: "dequeued", msgId: p.id });

  // The row just settled (running/awaiting reset, status in_progress) outside
  // any turn, and the `dequeued` publishes above are transcript detail the
  // coarse /api/events filter drops — announce the settle so every other tab's
  // spinners and "needs you" badges recount.
  publishGlobal(id, { type: "task_updated" });

  return NextResponse.json({ task: next, summary, generation: gen + 1 });
}
