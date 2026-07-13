import { NextResponse } from "next/server";
import { getProject } from "@/lib/store";
import { startRefreshJob, getRefreshState, clearRefresh } from "@/lib/contextRefresh";

export const dynamic = "force-dynamic";

// "Refresh with AI" runs as a DETACHED background job (see lib/contextRefresh.ts):
// the agent reads the repo and drafts fresh project context, persisting the
// result so it survives sleep/reconnect/reload. The result is NOT auto-saved —
// the client reviews the draft and decides whether to keep it.
//
//   POST   start the job, return its (running) state immediately
//   GET    poll the current job state { status, draft, error, started_at }
//   DELETE acknowledge a finished draft (clear it back to idle)

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getProject(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const state = startRefreshJob(id);
    return NextResponse.json(state, { status: 202 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const state = getRefreshState(id);
  if (!state) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(state);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const state = clearRefresh(id);
  if (!state) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(state);
}
