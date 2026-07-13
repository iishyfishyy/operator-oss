import { NextResponse } from "next/server";
import { getProject, listProjectSessions } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getProject(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(listProjectSessions(id));
}
