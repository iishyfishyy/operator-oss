import { NextResponse } from "next/server";
import { mergeChain, ChainError } from "@/lib/chainMerge";
import { jsonGuard } from "@/lib/apiGuard";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Land an auto-advance chain with ONE merge: the target step's branch (the last
// step by default, or `through`) carries every step before it (stacked
// branches). Every landed step is marked merged + done with its own insights
// row. Refused (409) while any step in the chain is running. A conflict comes
// back as a 409 MergeResult naming `targetTaskId` — resolve via
// /merge/prepare, then POST here again. See lib/chainMerge.ts.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return jsonGuard(`chain merge ${id}`, async () => {
    const body = (await req.json().catch(() => ({}))) as { through?: unknown };
    const through = typeof body.through === "string" && body.through ? body.through : undefined;
    try {
      const result = await mergeChain(id, through);
      return NextResponse.json(result, { status: result.ok ? 200 : 409 });
    } catch (e) {
      if (e instanceof ChainError) return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
      throw e;
    }
  });
}
