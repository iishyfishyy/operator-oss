import { NextResponse } from "next/server";
import { ghStatus } from "@/lib/github";

export const dynamic = "force-dynamic";

// Is the GitHub CLI available, and is this workspace logged in?
export async function GET() {
  return NextResponse.json(await ghStatus());
}
