import { NextResponse } from "next/server";
import { createTask, getProject, listAllTasksLite } from "@/lib/store";
import { track } from "@/lib/analytics";

export const dynamic = "force-dynamic";

// Powers the ⌘K palette's session search: every real task across all active
// projects, labeled with its project. Fetched fresh each time the palette opens.
export async function GET() {
  return NextResponse.json({ tasks: listAllTasksLite() });
}

export async function POST(req: Request) {
  const body = await req.json();
  if (!body?.project_id || !getProject(body.project_id))
    return NextResponse.json({ error: "valid project_id required" }, { status: 400 });
  if (!body?.title?.trim()) return NextResponse.json({ error: "title required" }, { status: 400 });
  const task = createTask({
    project_id: body.project_id,
    title: body.title.trim(),
    description: body.description ?? "",
    priority: body.priority ?? "med",
    suggested: !!body.suggested,
    // Agent is chosen at creation and fixed for the task's life (sessions can't
    // migrate between CLIs); createTask falls back to the project default.
    agent: typeof body.agent === "string" ? body.agent : undefined,
  });
  // `suggested` tasks are agent proposals in the tray; a real user-created task
  // is the funnel's "first task" step. Flag which so the funnel can filter.
  track("task_created", { task_id: task.id, project_id: task.project_id, suggested: !!body.suggested });
  return NextResponse.json(task, { status: 201 });
}
