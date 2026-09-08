import { NextResponse } from "next/server";
import { acceptSuggestedBatch } from "@/lib/store";
import { publishGlobal } from "@/lib/events";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body?.ids) || !body.ids.length || body.ids.length > 1000 ||
      !body.ids.every((id: unknown) => typeof id === "string" && id.length > 0) ||
      new Set(body.ids).size !== body.ids.length ||
      (body.start_chain !== undefined && typeof body.start_chain !== "boolean") ||
      (body.confirmed_roots !== undefined && typeof body.confirmed_roots !== "boolean")) {
    return NextResponse.json({ error: "Unique task ids and optional boolean start_chain/confirmed_roots required" }, { status: 400 });
  }
  try {
    const result = acceptSuggestedBatch(body.ids, body.start_chain === true, body.confirmed_roots === true);
    for (const task of result.tasks) publishGlobal(task.id, { type: "task_updated" });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Batch acceptance failed" }, { status: 409 });
  }
}
