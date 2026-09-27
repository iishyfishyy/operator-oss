import { NextResponse } from "next/server";
import { sendBackChain } from "@/lib/chainActions";
import { ChainError } from "@/lib/chainMerge";
import { jsonGuard } from "@/lib/apiGuard";

export const dynamic = "force-dynamic";

// Chain review "Send back": run the user's feedback as a fix-up turn on the
// chain's last step (its worktree stacks every step). Body: { feedback, about? }
// where `about` is the step id the feedback names. Returns once the turn is
// launched — watch it on that step's /messages stream. See lib/chainActions.ts.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return jsonGuard(`chain send-back ${id}`, async () => {
    const body = (await req.json().catch(() => ({}))) as { feedback?: unknown; about?: unknown };
    const feedback = typeof body.feedback === "string" ? body.feedback : "";
    const about = typeof body.about === "string" && body.about ? body.about : undefined;
    try {
      return NextResponse.json(await sendBackChain(id, feedback, about), { status: 202 });
    } catch (e) {
      if (e instanceof ChainError) return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
      throw e;
    }
  });
}
