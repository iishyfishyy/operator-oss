import { NextResponse } from "next/server";
import { getDriverStrict } from "@/lib/agents/registry";

export const dynamic = "force-dynamic";

// Live "is this agent signed in, and as whom" — reads the driver's own auth
// status (which shells out to its CLI). Agent-scoped mirror of the status half
// of app/api/claude/*. The persisted connection record (GET /api/agents) is the
// fast path the UI gates on; this is the authoritative recheck.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const driver = getDriverStrict(id);
  if (!driver) return NextResponse.json({ error: "unknown agent" }, { status: 404 });
  return NextResponse.json(await driver.authStatus());
}
