import { NextResponse } from "next/server";
import { cloneRepo, validRepoSpec } from "@/lib/github";

export const dynamic = "force-dynamic";

// Clone a repo (owner/repo or URL) into the workspace's projects dir. Returns
// where it landed + its default branch so project creation can point at it.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const spec = typeof body?.repo === "string" ? body.repo.trim() : "";
  if (!spec || !validRepoSpec(spec.replace(/\/+$/, ""))) {
    return NextResponse.json({ error: "repository must look like owner/repo or a GitHub URL" }, { status: 400 });
  }
  try {
    return NextResponse.json(await cloneRepo(spec));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "clone failed" }, { status: 500 });
  }
}
