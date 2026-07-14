import { NextResponse } from "next/server";
import { getTask, getProject, updateTask, listSummaries } from "@/lib/store";
import { commitWorktree } from "@/lib/git";
import { createTaskPr, buildPrBody } from "@/lib/github";
import { track } from "@/lib/analytics";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

// The review-on-GitHub complement to merge: push the task's work branch to
// origin and open a PR against the project's base branch (gh pr create), with
// title/body prefilled from the task. Idempotent — clicking again re-pushes and
// returns the already-open PR's URL, so it doubles as "Update PR".
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (task.running)
    return NextResponse.json({ error: "task is running — wait for the session to finish before opening a PR" }, { status: 409 });
  if (!task.worktree_path || !task.work_branch)
    return NextResponse.json({ error: "this task has no isolated branch to open a PR from" }, { status: 400 });
  const project = getProject(task.project_id);
  if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });

  // Commit whatever's still uncommitted first (same as merge does), so the PR
  // shows the same diff the Changes tab does.
  try {
    await commitWorktree(task.worktree_path, `${task.title} (orchestrator task ${task.id})`);
  } catch (e) {
    return NextResponse.json({ ok: false, error: `commit failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 409 });
  }

  // Latest session summary (generations are ordered; last = most recent /clear).
  const summaries = listSummaries(id);
  const result = await createTaskPr({
    worktreePath: task.worktree_path,
    workBranch: task.work_branch,
    baseBranch: project.branch,
    title: task.title,
    body: buildPrBody({ description: task.description, summary: summaries[summaries.length - 1]?.summary, taskId: id }),
  });

  if (result.ok && result.url) {
    updateTask(id, { pr_url: result.url });
    track("task_pr_created", { task_id: id, project_id: project.id, existing: !!result.existing });
  }
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
