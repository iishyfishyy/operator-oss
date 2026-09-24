import { NextResponse } from "next/server";
import { getTask } from "@/lib/store";
import { listPromptCaptures } from "@/lib/promptCapture";
import { resolveFeatures } from "@/lib/features";

export const dynamic = "force-dynamic";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const headers = { "Cache-Control": "no-store" };
  if (!resolveFeatures().debugPrompts) return NextResponse.json({ error: "Prompt debugging is disabled" }, { status: 404, headers });
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404, headers });
  return NextResponse.json({ captures: listPromptCaptures(task.project_id, id) }, { headers });
}
