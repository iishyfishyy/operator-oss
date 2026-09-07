import { NextResponse, type NextRequest } from "next/server";
import { getProject, getTask } from "@/lib/store";
import { createSuggestedTask } from "@/lib/agentTools";
import type { Priority } from "@/lib/types";

export const dynamic = "force-dynamic";

// Internal endpoint the stdio MCP bridge (scripts/orch-mcp.mjs) proxies the
// `suggest_task` tool call to, so non-Claude agents (Codex, future CLIs) get the
// same tool the Claude driver mounts in-process. Auth is the per-instance
// SERVICE_TOKEN, enforced in middleware.ts (isAgentToolPath). The bridge has
// already resolved any title refs in `blocked_by` to task ids, and always sends
// the running task's id (same identity ask_user relies on) so the suggestion can
// be stamped with the session that proposed it.
export async function POST(req: NextRequest) {
  let body: {
    projectId?: string;
    taskId?: string;
    title?: string;
    description?: string;
    priority?: Priority;
    blocked_by?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const project = body.projectId ? getProject(body.projectId) : undefined;
  if (!project) return NextResponse.json({ error: "unknown project" }, { status: 404 });
  if (!body.title?.trim()) return NextResponse.json({ error: "title is required" }, { status: 400 });

  // Provenance comes from the live row rather than the bridge: the generation is
  // whatever the proposing task is on right now, and an unknown/deleted taskId
  // simply yields no source (the suggestion lands ungrouped instead of failing).
  const parent = body.taskId ? getTask(body.taskId) : undefined;
  const { task, text } = createSuggestedTask(
    project,
    {
      title: body.title,
      description: body.description ?? "",
      priority: body.priority,
      blocked_by: Array.isArray(body.blocked_by) ? body.blocked_by : undefined,
    },
    parent ? { taskId: parent.id, generation: parent.generation } : undefined
  );
  if (!task) return NextResponse.json({ error: text }, { status: 404 });
  return NextResponse.json({ ok: true, id: task.id, title: task.title, text });
}
