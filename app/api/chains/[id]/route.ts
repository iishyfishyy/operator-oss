import { NextResponse } from "next/server";
import { getChainView } from "@/lib/chainMerge";
import { jsonGuard } from "@/lib/apiGuard";

export const dynamic = "force-dynamic";

// The chain review panel's data: every step in order (title, complete_step
// summary, +/- lines, status, per-step merge eligibility) plus chain-level
// progress stats and any staged conflict resolution. See lib/chainMerge.ts.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return jsonGuard(`chain ${id}`, async () => {
    const view = await getChainView(id);
    if (!view) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(view);
  });
}
