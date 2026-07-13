import { NextResponse } from "next/server";
import { sweepRecaps } from "@/lib/recap";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Generate recaps for any stale projects with new activity. Called by the
// client on load and on an interval; idempotent (only touches projects due).
export async function POST() {
  const generated = await sweepRecaps();
  return NextResponse.json({ generated });
}
