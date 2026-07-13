import { NextResponse } from "next/server";
import { getProject, updateProject, deleteProject } from "@/lib/store";
import { listTasks } from "@/lib/store";
import { removeWorktree } from "@/lib/git";
import { removeTaskUploads } from "@/lib/uploads";
import { abortTurn } from "@/lib/abort";
import { removeProjectServices } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ...project, tasks: listTasks(id) });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const patch = await req.json();
  const project = updateProject(id, patch);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(project);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  const tasks = listTasks(id);
  // Stop any in-flight turns BEFORE the cascade drops their task rows. A live
  // turn keeps writing to SQLite (addMessage, updateTask); once its row is gone
  // those writes hit a FOREIGN KEY error, and the second such throw (from the
  // error handler re-persisting) escapes the runner and, unhandled, would take
  // down the whole server process — killing every other tenant's turn. Mirror
  // the task DELETE handler, which aborts before teardown for the same reason.
  for (const t of tasks) abortTurn(t.id);
  // Tear down each task's worktree + uploaded chat images before the DB
  // cascade drops the rows.
  for (const t of tasks) {
    if (project.repo_path && t.worktree_path) await removeWorktree(project.repo_path, t.worktree_path, t.work_branch);
    removeTaskUploads(t.id);
  }
  // Kill this project's managed dev-server processes and drop their live registry
  // entries BEFORE the cascade drops the services rows — otherwise the detached
  // children leak (holding the project's port) and the public <slug>--<host>
  // router keeps routing to a now-deleted project until the server restarts.
  removeProjectServices(id);
  deleteProject(id);
  return NextResponse.json({ ok: true });
}
