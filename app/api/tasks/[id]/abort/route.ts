import { NextResponse } from "next/server";
import { abortTurn } from "@/lib/abort";
import { clearPendingMessages } from "@/lib/store";
import { publish } from "@/lib/events";

export const dynamic = "force-dynamic";

// Signal the active turn for a task to stop. The streaming turn's loop unwinds,
// persists its partial transcript, and leaves the task awaiting_input (see the
// runner's finally block). No-op (aborted=false) if nothing is running.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const aborted = abortTurn(id);
  // Stop discards the parked queue — those follow-ups were lined up behind the
  // train of thought the user just interrupted. Do it here, synchronously at
  // press time: the dying turn's finally also clears it, but if a NEW turn
  // starts before the stopped one unwinds, that finally defers to the successor
  // and would otherwise leave pre-Stop follow-ups queued behind a turn they
  // were never meant for. Messages sent after this instant belong to whatever
  // comes next and are untouched.
  if (aborted) {
    for (const p of clearPendingMessages(id)) publish(id, { type: "dequeued", msgId: p.id });
  }
  return NextResponse.json({ ok: true, aborted });
}
