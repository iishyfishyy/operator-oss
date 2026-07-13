import { NextResponse, type NextRequest } from "next/server";
import { getProject } from "@/lib/store";
import { createSuggestedTask } from "@/lib/agentTools";
import type { Priority } from "@/lib/types";

export const dynamic = "force-dynamic";

// Internal endpoint the stdio MCP bridge (scripts/orch-mcp.mjs) proxies the
// `suggest_task` tool call to, so non-Claude agents (Codex, future CLIs) get the
// same tool the Claude driver mounts in-process. Auth is the per-instance
// SERVICE_TOKEN, enforced in middleware.ts (isAgentToolPath). The bridge has
// already resolved any title refs in `blocked_by` to task ids.
export async function POST(req: NextRequest) {
  let body: {
    projectId?: string;
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

  const { task, text } = createSuggestedTask(project, {
    title: body.title,
    description: body.description ?? "",
    priority: body.priority,
    blocked_by: Array.isArray(body.blocked_by) ? body.blocked_by : undefined,
  });
  return NextResponse.json({ ok: true, id: task.id, title: task.title, text });
}
