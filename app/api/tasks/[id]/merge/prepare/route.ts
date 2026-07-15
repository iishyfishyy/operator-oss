import { NextResponse } from "next/server";
import { getTask, getProject, updateTask } from "@/lib/store";
import { prepareWorktreeMerge, completeWorktreeMerge } from "@/lib/git";
import { buildConflictPrompt } from "@/lib/agents/shared";
import { hasTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";
import { jsonGuard } from "@/lib/apiGuard";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Materialize a task branch's merge conflicts inside its isolated worktree so
// they can be resolved (by AI or by hand). If the trial merge turns out clean,
// land it immediately — there's nothing to resolve.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Locked against the turn-launch path: the trial merge (and the land step on
  // a clean result) commits the whole worktree, so the running check must stay
  // true for the duration — no turn may start writing mid-commit.
  return jsonGuard(`merge/prepare ${id}`, () => withTaskLock(id, async () => {
    const task = getTask(id);
    if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (task.running || hasTurn(id))
      return NextResponse.json({ error: "task is running — wait for the session to finish before merging" }, { status: 409 });
    if (!task.worktree_path || !task.work_branch)
      return NextResponse.json({ error: "this task has no isolated branch to merge" }, { status: 400 });
    const project = getProject(task.project_id);
    if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });

    const message = `${task.title} (orchestrator task ${task.id})`;
    const prep = await prepareWorktreeMerge({
      repoPath: project.repo_path,
      worktreePath: task.worktree_path,
      baseBranch: project.branch,
      message,
    });

    if (!prep.ok) return NextResponse.json(prep, { status: 409 });

    // Clean trial merge — nothing to resolve, so land it now.
    if (prep.clean) {
      const result = await completeWorktreeMerge({
        repoPath: project.repo_path,
        worktreePath: task.worktree_path,
        workBranch: task.work_branch,
        baseBranch: project.branch,
        message,
      });
      if (result.ok) {
        // Record the merge and advance the diff base — but do NOT change status.
        // Merging is a git action, not a declaration that the task is finished;
        // the user may merge several rounds while still iterating. They own "done".
        updateTask(id, {
          merged_at: Date.now(),
          ...(result.mergedSha ? { base_sha: result.mergedSha } : {}),
        });
      }
      return NextResponse.json({ ...prep, merged: result }, { status: result.ok ? 200 : 409 });
    }

    // Conflicts present — hand back the file lists plus a ready-to-send prompt for
    // an AI resolution turn (the client streams it through the normal turn path).
    return NextResponse.json(
      { ...prep, prompt: buildConflictPrompt(project.branch, prep.conflicts) },
      { status: 200 }
    );
  }));
}
