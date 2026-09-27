import { NextResponse } from "next/server";
import { rebaseChainStack } from "@/lib/chainActions";
import { ChainError } from "@/lib/chainMerge";
import { jsonGuard } from "@/lib/apiGuard";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Chain review "Rebase stack": the base branch moved — replay the unmerged
// stack onto its new tip, all or nothing (a conflict rolls every step back and
// comes back as a 409 naming the step). See lib/chainActions.ts.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return jsonGuard(`chain rebase ${id}`, async () => {
    try {
      const result = await rebaseChainStack(id);
      return NextResponse.json(result, { status: result.ok ? 200 : 409 });
    } catch (e) {
      if (e instanceof ChainError) return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
      throw e;
    }
  });
}
