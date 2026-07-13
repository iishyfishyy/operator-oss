import { NextResponse } from "next/server";
import { getTask, getProject, updateTask, recordTaskMerge } from "@/lib/store";
import { completeWorktreeMerge } from "@/lib/git";
import { hasTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Accept a resolved conflict: commit the merge in the worktree and land the
// (now conflict-free) work branch into the base branch.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Locked against the turn-launch path: committing the resolved merge stages
  // the whole worktree, so no turn may start writing into it mid-commit.
  return withTaskLock(id, async () => {
    const task = getTask(id);
    if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (task.running || hasTurn(id))
      return NextResponse.json({ error: "task is running — wait for the session to finish before merging" }, { status: 409 });
    if (!task.worktree_path || !task.work_branch)
      return NextResponse.json({ error: "this task has no isolated branch to merge" }, { status: 400 });
    const project = getProject(task.project_id);
    if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });

    const result = await completeWorktreeMerge({
      repoPath: project.repo_path,
      worktreePath: task.worktree_path,
      workBranch: task.work_branch,
      baseBranch: project.branch,
      message: `${task.title} (orchestrator task ${task.id})`,
    });

    if (result.ok) {
      // Record the merge and advance the diff base — but do NOT change status.
      // Merging (even after resolving conflicts) is a git action, not a sign the
      // task is finished; the user owns the "done" status and sets it manually.
      updateTask(id, {
        merged_at: Date.now(),
        ...(result.mergedSha ? { base_sha: result.mergedSha } : {}),
      });
      // Insights: persist what this merge landed (see merge/route.ts).
      if (!result.alreadyMerged)
        recordTaskMerge({
          project_id: project.id, task_id: id, agent: task.agent,
          additions: result.additions ?? 0, deletions: result.deletions ?? 0,
        });
    }
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  });
}
