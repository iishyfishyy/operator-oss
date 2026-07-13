import { NextResponse } from "next/server";
import { listNeedsYou } from "@/lib/store";

export const dynamic = "force-dynamic";

// Powers the titlebar "N need you" dropdown: the actual awaiting tasks across all
// active projects (not just per-project counts), so the menu can list them with a
// project label and a "waiting for <duration>" age. Fetched fresh each open.
export async function GET() {
  return NextResponse.json({ tasks: listNeedsYou() });
}
