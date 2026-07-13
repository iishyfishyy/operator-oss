import { NextResponse } from "next/server";
import { deletePendingMessage } from "@/lib/store";
import { publish } from "@/lib/events";

export const dynamic = "force-dynamic";

// Cancel a queued (not-yet-run) follow-up the user typed mid-turn. Removes it
// from the parked queue and publishes `dequeued` so every open stream drops its
// "queued" bubble. No-op if the id is unknown (already run or already cancelled).
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { pendingId } = await req.json().catch(() => ({ pendingId: undefined }));
  const removed = pendingId ? deletePendingMessage(String(pendingId)) : undefined;
  // Guard on task ownership so one task can't drop another's queued message.
  if (removed && removed.task_id === id) publish(id, { type: "dequeued", msgId: removed.id });
  return NextResponse.json({ ok: true, removed: !!(removed && removed.task_id === id) });
}
