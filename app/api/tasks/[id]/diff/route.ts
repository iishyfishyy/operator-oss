import { NextResponse } from "next/server";
import { getTask, getProject, updateTask } from "@/lib/store";
import { taskDiff, worktreeMergeStatus } from "@/lib/git";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  const project = getProject(task.project_id);
  if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });

  // Tasks without an isolated worktree ran directly in the repo — nothing
  // branch-scoped to diff.
  if (!task.worktree_path) {
    return NextResponse.json({
      isolated: false,
      files: [],
      patch: "",
      isDirty: false,
      ahead: 0,
      reason: "This task runs in the main repo (no isolated branch).",
    });
  }

  try {
    const diff = await taskDiff(project.repo_path, task.worktree_path, task.base_sha, project.branch);
    // An in-progress trial merge (conflict resolution) means the branch isn't
    // really "already merged" yet — report its state so the UI can show the
    // accept/discard review instead of a done badge.
    const mergeState = await worktreeMergeStatus(task.worktree_path);
    // Self-heal: if the branch is already in the base branch but we never
    // recorded the merge (e.g. merged via CLI), backfill merged_at so the DB
    // stays the single source of truth. Status is left untouched — merely
    // viewing the Changes tab must never mark a task done. The user owns that.
    let merged_at = task.merged_at;
    if (diff.alreadyMerged && !mergeState.mergeInProgress && !merged_at) {
      merged_at = updateTask(id, { merged_at: Date.now() })?.merged_at ?? Date.now();
    } else if (merged_at && diff.ahead > 0 && !mergeState.mergeInProgress) {
      // The task was merged, but new commits have since landed on the work branch
      // (the diff base was advanced to the merged tip, so ahead>0 means post-merge
      // work). "Merged" no longer reflects reality — clear the flag so the badge is
      // honest and the task drops out of the prune candidate list. Status is left
      // untouched; the user still owns "done".
      merged_at = updateTask(id, { merged_at: 0 })?.merged_at ?? 0;
    }
    return NextResponse.json({
      isolated: true,
      branch: task.work_branch,
      merged_at,
      ...diff,
      mergeInProgress: mergeState.mergeInProgress,
      unresolved: mergeState.unresolved,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
