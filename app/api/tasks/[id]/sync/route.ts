import { NextResponse } from "next/server";
import { getTask, getProject, updateTask } from "@/lib/store";
import { worktreeSyncStatus, fastForwardWorktree, prepareWorktreeMerge } from "@/lib/git";
import { buildConflictPrompt } from "@/lib/agents/shared";
import { hasTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// GET: read-only divergence + conflict prediction for the sync banner. Computed on
// task open; mutates NOTHING (merge-tree predicts conflicts without a trial merge).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  const project = getProject(task.project_id);
  if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });
  if (!task.worktree_path || !task.work_branch) return NextResponse.json({ isolated: false });

  const status = await worktreeSyncStatus({
    repoPath: project.repo_path,
    worktreePath: task.worktree_path,
    workBranch: task.work_branch,
    baseBranch: project.branch,
  });
  return NextResponse.json({ isolated: true, baseBranch: project.branch, ...status });
}

// POST: actually bring the worktree up to date with the base branch. Triggered by
// the Sync button (clean merge) — the fast-forward tier resolves silently on the
// next follow-up message instead (see the messages route).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Runs under the per-task lock shared with the turn-launch path so the
  // running check stays true for the whole sync — a turn can't start writing
  // into the worktree while the fast-forward/merge below is rewriting it.
  return withTaskLock(id, async () => {
    const task = getTask(id);
    if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (task.running || hasTurn(id))
      return NextResponse.json({ error: "task is running — wait for the session to finish before syncing" }, { status: 409 });
    if (!task.worktree_path || !task.work_branch)
      return NextResponse.json({ error: "this task has no isolated worktree to sync" }, { status: 400 });
    const project = getProject(task.project_id);
    if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });

    const status = await worktreeSyncStatus({
      repoPath: project.repo_path,
      worktreePath: task.worktree_path,
      workBranch: task.work_branch,
      baseBranch: project.branch,
    });
    if (status.behind === 0) return NextResponse.json({ ok: true, upToDate: true, behind: 0 });

    // Tier 1: fast-forward (no divergent work + clean tree). After it, the work
    // branch == base tip, so reset the diff base there too (the branch's changes
    // are all in the base now — nothing task-specific to show).
    if (status.canFastForward) {
      const ok = await fastForwardWorktree(task.worktree_path, project.branch);
      if (ok && status.baseTip) updateTask(id, { base_sha: status.baseTip });
      return NextResponse.json(
        { ok, fastForwarded: ok, behind: status.behind, ...(ok ? {} : { error: "fast-forward failed" }) },
        { status: ok ? 200 : 409 }
      );
    }

    // Tier 2/3: merge the base branch INTO the work branch inside the isolated
    // worktree — the same prepareWorktreeMerge used for conflict resolution, but
    // WITHOUT the auto-land step (a sync brings the worktree up to date; it does
    // not push the task's work into main).
    const message = `Sync ${project.branch} into ${task.title} (orchestrator task ${task.id})`;
    const prep = await prepareWorktreeMerge({
      repoPath: project.repo_path,
      worktreePath: task.worktree_path,
      baseBranch: project.branch,
      message,
    });
    if (!prep.ok) return NextResponse.json({ ok: false, error: prep.error }, { status: 409 });

    if (prep.clean) {
      // Merge committed cleanly — base tip is now an ancestor of HEAD, so advance the
      // diff base to it: the Changes view then shows only the task's own work on top
      // of main, not all of main's intervening commits.
      if (status.baseTip) updateTask(id, { base_sha: status.baseTip });
      return NextResponse.json({ ok: true, synced: true, behind: status.behind });
    }

    // Conflicts (prediction can be wrong at the margin) — markers are now in the
    // worktree. Hand back the file lists + a resolution prompt so the client can
    // escalate to the existing Fix-with-AI flow.
    return NextResponse.json(
      { ok: true, conflicts: prep.conflicts, binaryConflicts: prep.binaryConflicts, prompt: buildConflictPrompt(project.branch, prep.conflicts) },
      { status: 200 }
    );
  });
}
