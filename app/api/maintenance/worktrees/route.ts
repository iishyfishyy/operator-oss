import { NextResponse } from "next/server";
import { listPrunableWorktrees, getTask, getProject, updateTask } from "@/lib/store";
import { removeWorktree, worktreeDiskUsage, worktreePruneSafety } from "@/lib/git";
import { hasTurn } from "@/lib/abort";

export const dynamic = "force-dynamic";

// GET: the merged tasks whose worktrees are still on disk, each with the disk it
// would reclaim. This is the data behind the "Prune merged worktrees" cleanup —
// the user picks from these. Removing a worktree keeps the branch by default, so
// the diff base survives and the task stays reopenable. IMPORTANT: "merged" only
// means merged once — a task may have grown new work since (uncommitted edits, or
// commits not yet re-merged). Those candidates are flagged `unsafe` here (and made
// non-selectable in the UI) so we never present unmerged work as safe to reclaim.
export async function GET() {
  const rows = listPrunableWorktrees();
  const candidates = (
    await Promise.all(
      rows.map(async (r) => {
        const sizeBytes = await worktreeDiskUsage(r.worktree_path);
        // worktree_path set but gone from disk (pruned out-of-band, or removed
        // manually) — nothing to reclaim, so drop it from the list.
        if (sizeBytes <= 0) return null;
        const safety = await worktreePruneSafety({
          repoPath: r.repo_path,
          worktreePath: r.worktree_path,
          workBranch: r.work_branch,
          baseBranch: r.base_branch,
        });
        return {
          taskId: r.id,
          title: r.title,
          projectId: r.project_id,
          projectName: r.project_name,
          branch: r.work_branch,
          mergedAt: r.merged_at,
          sizeBytes,
          running: hasTurn(r.id),
          unsafe: !safety.safe,
          unsafeReason: safety.reason ?? null,
        };
      })
    )
  ).filter((c): c is NonNullable<typeof c> => c !== null);

  const totalBytes = candidates.reduce((sum, c) => sum + c.sizeBytes, 0);
  return NextResponse.json({ candidates, totalBytes });
}

// POST: prune the selected tasks' worktrees. Reclaims disk; keeps each branch
// unless `deleteBranch` is explicitly set. After removal we clear the task's
// worktree_path (and, on branch delete, its branch/base) so nothing points at a
// directory that no longer exists — the messages route re-creates the worktree
// on demand if the task is reopened.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { taskIds?: unknown; deleteBranch?: unknown };
  const taskIds = Array.isArray(body.taskIds) ? body.taskIds.filter((x): x is string => typeof x === "string") : [];
  const deleteBranch = body.deleteBranch === true;
  if (taskIds.length === 0) return NextResponse.json({ error: "no tasks selected" }, { status: 400 });

  let reclaimedBytes = 0;
  const pruned: string[] = [];
  const skipped: { taskId: string; reason: string }[] = [];

  for (const id of taskIds) {
    const task = getTask(id);
    if (!task || !task.worktree_path) {
      skipped.push({ taskId: id, reason: "not found or already pruned" });
      continue;
    }
    // Don't yank a worktree out from under a live turn.
    if (hasTurn(id)) {
      skipped.push({ taskId: id, reason: "a turn is currently running" });
      continue;
    }
    if (!task.merged_at) {
      skipped.push({ taskId: id, reason: "not merged" });
      continue;
    }
    const project = getProject(task.project_id);
    if (!project?.repo_path) {
      skipped.push({ taskId: id, reason: "project has no repo" });
      continue;
    }
    // Re-check at execution time (the list may be stale, or a follow-up turn may
    // have added work after the merge): never force-remove a worktree that still
    // holds uncommitted edits or commits not yet in the base branch.
    const safety = await worktreePruneSafety({
      repoPath: project.repo_path,
      worktreePath: task.worktree_path,
      workBranch: task.work_branch,
      baseBranch: project.branch,
    });
    if (!safety.safe) {
      skipped.push({ taskId: id, reason: `has unmerged work — ${safety.reason}` });
      continue;
    }
    reclaimedBytes += await worktreeDiskUsage(task.worktree_path);
    await removeWorktree(project.repo_path, task.worktree_path, task.work_branch, { keepBranch: !deleteBranch });
    updateTask(id, {
      worktree_path: "",
      ...(deleteBranch ? { work_branch: "", base_sha: "" } : {}),
    });
    pruned.push(id);
  }

  return NextResponse.json({ pruned, skipped, reclaimedBytes });
}
