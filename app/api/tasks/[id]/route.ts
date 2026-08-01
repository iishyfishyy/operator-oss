import { NextResponse } from "next/server";
import { getTask, getProject, updateTask, deleteTask, listMessages, getTaskUsage, getTaskContext, getTaskDeps, setTaskDeps, countAwaiting, isTaskAwaiting } from "@/lib/store";
import { removeWorktree } from "@/lib/git";
import { removeTaskUploads } from "@/lib/uploads";
import { abortTurn } from "@/lib/abort";
import { publishGlobal } from "@/lib/events";
import type { Task } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  const usage = getTaskUsage(id);
  const ctx = getTaskContext(id);
  return NextResponse.json({
    ...task,
    // Derived (NEEDS_YOU) so a settled + already-viewed task doesn't nag
    // in the list after turn_end triggers this refetch. Raw column stays
    // on the row for internal writers; only the wire value is derived.
    awaiting_input: isTaskAwaiting(id) ? 1 : 0,
    cost_usd: usage.cost_usd,
    total_tokens: usage.total_tokens,
    // The cache buckets travel with the total so the usage chip can split
    // "fresh work" from re-read context instead of showing one inflated number.
    cache_read_tokens: usage.cache_read_tokens,
    cache_creation_tokens: usage.cache_creation_tokens,
    context_tokens: ctx.context_tokens,
    context_pct: ctx.context_pct,
    depends_on: getTaskDeps(id),
    messages: listMessages(id),
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json()) as Partial<Task>;
  // Whitelist user-editable fields.
  const allowed: Partial<Task> = {};
  for (const k of ["title", "description", "priority", "status", "suggested", "model", "reasoning", "permission_mode"] as const) {
    if (k in body) (allowed as Record<string, unknown>)[k] = body[k];
  }
  // A manual status change is the user taking the wheel — clear the "your turn" flag.
  if ("status" in allowed) allowed.awaiting_input = 0;
  // Cancelling means "stop working on this": kill any in-flight turn. The
  // runner's finally block settles running=0 and discards the parked queue.
  // (The worktree is kept — Cancelled ≠ Delete — so the diff stays reviewable
  // and the task can be revived by just sending another message.)
  if (allowed.status === "cancelled") abortTurn(id);
  // Dependency edges live in their own table — set them separately, with a cycle guard.
  if (Array.isArray((body as { depends_on?: unknown }).depends_on)) {
    try {
      setTaskDeps(id, (body as { depends_on: string[] }).depends_on);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "invalid dependencies" }, { status: 400 });
    }
  }
  const task = updateTask(id, allowed);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  // A manual status change settles status + awaiting_input outside any turn, so
  // no runner publish will follow — announce it ourselves or every other tab's
  // "needs you" badges keep counting this task until their next reconnect.
  if ("status" in allowed) publishGlobal(id, { type: "task_updated" });
  return NextResponse.json({ ...task, depends_on: getTaskDeps(id) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  // Stop any in-flight turn before tearing down its worktree, so the runner
  // isn't mid-write when the directory disappears.
  abortTurn(id);
  if (task?.worktree_path) {
    const project = getProject(task.project_id);
    if (project?.repo_path) await removeWorktree(project.repo_path, task.worktree_path, task.work_branch);
  }
  removeTaskUploads(id);
  deleteTask(id);
  // Publish AFTER the hard delete, carrying the project id + its recomputed
  // awaiting count: the row is gone, so /api/events' usual re-read-the-task
  // enrichment would drop the event and freeze the project's badge in every
  // other tab until the next SSE reconnect.
  if (task) publishGlobal(id, { type: "task_deleted", projectId: task.project_id, awaiting_count: countAwaiting(task.project_id) });
  return NextResponse.json({ ok: true });
}
