import { NextResponse, type NextRequest } from "next/server";
import { getProject } from "@/lib/store";
import { registerExposedService } from "@/lib/agentTools";

export const dynamic = "force-dynamic";

// Internal endpoint the stdio MCP bridge (scripts/orch-mcp.mjs) proxies the
// `expose_service` tool call to — the HTTP counterpart of the Claude driver's
// in-process tool. Auth is the per-instance SERVICE_TOKEN (middleware.ts).
export async function POST(req: NextRequest) {
  let body: { projectId?: string; name?: string; port?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const project = body.projectId ? getProject(body.projectId) : undefined;
  if (!project) return NextResponse.json({ error: "unknown project" }, { status: 404 });
  const port = Number(body.port);
  if (!Number.isInteger(port) || port <= 0) {
    return NextResponse.json({ error: "port must be a positive integer" }, { status: 400 });
  }

  const { info, url, text } = registerExposedService(project, body.name ?? "dev", port);
  return NextResponse.json({ ok: true, name: info.name, url, visibility: info.visibility, text });
}
