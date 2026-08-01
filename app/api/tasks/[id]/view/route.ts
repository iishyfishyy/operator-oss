import { NextResponse } from "next/server";
import { getTask, markTaskViewed } from "@/lib/store";
import { publishGlobal } from "@/lib/events";

export const dynamic = "force-dynamic";

/**
 * Mark a task's transcript as viewed — stamp last_viewed_at to now. Fired by
 * the client (app/orchestrator/useTaskStream.ts) once its EventSource has
 * delivered the snapshot with the tab visible for ~2s. The stamp shifts the
 * derived "waiting on you" predicate (lib/store.ts NEEDS_YOU): a settled turn
 * (running=0) whose latest agent activity is now older than last_viewed_at no
 * longer counts, so its project badge and the titlebar "N need you" pill both
 * clear. A parked ask (running=1) stays lit regardless — an unanswered
 * question needs the user even when it's on screen.
 *
 * Publishes `task_updated` on the bus so /api/events broadcasts the fresh
 * derived awaiting_input + project awaiting_count to every open tab
 * immediately; no polling required.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getTask(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  markTaskViewed(id);
  publishGlobal(id, { type: "task_updated" });
  return NextResponse.json({ ok: true });
}
