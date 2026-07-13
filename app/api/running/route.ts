import { NextResponse } from "next/server";
import { listRunningTaskIds } from "@/lib/store";

export const dynamic = "force-dynamic";

// Lightweight fleet-wide "which tasks have a live turn" list. Cross-project
// turn boundaries normally arrive live on GET /api/events, but a turn_end
// published while that stream was disconnected is gone — and the client only
// refetches the selected project's rows, so a spinner on a task in a project
// it navigated away from would stick forever. On every SSE reconnect the
// client reconciles its running set against this authoritative list.
export async function GET() {
  return NextResponse.json({ ids: listRunningTaskIds() });
}
