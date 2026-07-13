import { NextResponse } from "next/server";
import { reorderProjects } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json();
  if (!Array.isArray(body?.ids) || !body.ids.every((id: unknown) => typeof id === "string")) {
    return NextResponse.json({ error: "ids (string[]) required" }, { status: 400 });
  }
  reorderProjects(body.ids);
  return NextResponse.json({ ok: true });
}
