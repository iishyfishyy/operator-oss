import { NextResponse } from "next/server";
import { discardChainFrom } from "@/lib/chainActions";
import { ChainError } from "@/lib/chainMerge";
import { jsonGuard } from "@/lib/apiGuard";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Chain review "Discard from step k": hard-delete steps k..n (turns stopped,
// worktrees + branches removed). Earlier steps stay reviewable and mergeable.
// Body: { from } — the step id to discard from. See lib/chainActions.ts.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return jsonGuard(`chain discard ${id}`, async () => {
    const body = (await req.json().catch(() => ({}))) as { from?: unknown };
    if (typeof body.from !== "string" || !body.from) return NextResponse.json({ ok: false, error: "from (a step id) is required" }, { status: 400 });
    try {
      return NextResponse.json(await discardChainFrom(id, body.from));
    } catch (e) {
      if (e instanceof ChainError) return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
      throw e;
    }
  });
}
