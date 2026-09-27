import { NextResponse, type NextRequest } from "next/server";
import { recordStepComplete } from "@/lib/agentTools";

export const dynamic = "force-dynamic";

// Internal endpoint the stdio MCP bridge (scripts/orch-mcp.mjs) proxies the
// `complete_step` tool call to — the HTTP counterpart of the Claude driver's
// in-process tool. Auth is the per-instance SERVICE_TOKEN (middleware.ts). The
// shared logic refuses tasks outside an auto-advance chain, so a bridge that
// somehow registered the tool can't mark an ordinary task finished.
export async function POST(req: NextRequest) {
  let body: { taskId?: string; summary?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.taskId) return NextResponse.json({ error: "taskId is required" }, { status: 400 });
  if (typeof body.summary !== "string") return NextResponse.json({ error: "summary must be a string" }, { status: 400 });

  const { ok, text } = recordStepComplete(body.taskId, body.summary);
  return NextResponse.json({ ok, text });
}
