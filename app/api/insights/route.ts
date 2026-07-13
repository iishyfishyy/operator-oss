import { NextResponse } from "next/server";
import { getInsightsData } from "@/lib/store";

export const dynamic = "force-dynamic";

// The Insights dashboard's single data fetch: per-day facts grouped by
// (day, project, agent) covering the widest range (90d) plus the same width
// again, so the client can compute prior-period deltas and switch every
// filter locally without refetching. See InsightsData in lib/store.ts.
const WINDOW_DAYS = 180;

export async function GET() {
  const since = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return NextResponse.json(getInsightsData(since));
}
