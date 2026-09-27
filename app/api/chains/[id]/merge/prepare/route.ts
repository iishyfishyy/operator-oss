import { NextResponse } from "next/server";
import { prepareChainMerge, ChainError } from "@/lib/chainMerge";
import { buildConflictPrompt } from "@/lib/agents/shared";
import { jsonGuard } from "@/lib/apiGuard";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// The chain merge's conflict path — the chain twin of
// /api/tasks/[id]/merge/prepare. Trial-merges the base branch into the target
// step's worktree (the last step, or `through`). Clean → the chain lands now
// (`merged`). Conflicts → the file lists plus a ready-to-send resolution
// prompt; the client streams it as a turn on `targetTaskId`, then retries
// POST /api/chains/[id]/merge, which completes the staged merge.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return jsonGuard(`chain merge/prepare ${id}`, async () => {
    const body = (await req.json().catch(() => ({}))) as { through?: unknown };
    const through = typeof body.through === "string" && body.through ? body.through : undefined;
    try {
      const prep = await prepareChainMerge(id, through);
      if (!prep.ok) return NextResponse.json(prep, { status: 409 });
      if (prep.merged) return NextResponse.json(prep, { status: prep.merged.ok ? 200 : 409 });
      if (prep.clean) return NextResponse.json(prep);
      return NextResponse.json({ ...prep, prompt: buildConflictPrompt(prep.baseBranch, prep.conflicts) });
    } catch (e) {
      if (e instanceof ChainError) return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
      throw e;
    }
  });
}
