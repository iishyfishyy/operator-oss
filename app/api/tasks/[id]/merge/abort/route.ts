import { NextResponse } from "next/server";
import { getTask, getProject } from "@/lib/store";
import { abortWorktreeMerge } from "@/lib/git";
import { hasTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Discard an in-progress conflict resolution, returning the worktree to a clean
// state so the task can be re-attempted or resolved differently.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Locked against the turn-launch path: merge --abort rewrites worktree files,
  // so no turn may start writing into them while it runs.
  return withTaskLock(id, async () => {
    const task = getTask(id);
    if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (task.running || hasTurn(id))
      return NextResponse.json({ error: "task is running — wait for the session to finish" }, { status: 409 });
    if (!task.worktree_path) return NextResponse.json({ error: "this task has no isolated worktree" }, { status: 400 });
    const project = getProject(task.project_id);
    if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });

    await abortWorktreeMerge(task.worktree_path);
    return NextResponse.json({ ok: true }, { status: 200 });
  });
}
