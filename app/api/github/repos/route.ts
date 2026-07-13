import { NextResponse } from "next/server";
import { listRepos } from "@/lib/github";

export const dynamic = "force-dynamic";

// The logged-in user's repos for the "Clone a repository" picker.
export async function GET() {
  try {
    return NextResponse.json(await listRepos());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "could not list repos" }, { status: 500 });
  }
}
