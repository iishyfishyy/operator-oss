import { NextResponse } from "next/server";
import { getProject } from "@/lib/store";
import { recapStatus, generateRecap } from "@/lib/recap";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Current recap + freshness flags for the project (no generation).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(recapStatus(project));
}

// Force-generate (or refresh) the recap and return it.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  const recap = await generateRecap(id);
  if (recap == null) return NextResponse.json({ error: "nothing to recap" }, { status: 409 });
  const fresh = getProject(id)!;
  return NextResponse.json({ recap, recap_at: fresh.recap_at });
}
