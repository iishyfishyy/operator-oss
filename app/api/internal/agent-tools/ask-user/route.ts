import { NextResponse, type NextRequest } from "next/server";
import { getTask } from "@/lib/store";
import { startAskUser } from "@/lib/agentTools";
import { hasTurn } from "@/lib/abort";
import type { AskQuestion, AskOption } from "@/lib/types";

export const dynamic = "force-dynamic";

// Internal endpoint the stdio MCP bridge (scripts/orch-mcp.mjs) proxies the
// `ask_user` tool call to. Persists + publishes the interactive ask card and
// parks a detached waiter on the user's answer; the bridge then polls the
// sibling `wait` endpoint for the outcome. Auth is the per-instance
// SERVICE_TOKEN, enforced in middleware.ts (isAgentToolPath).

// Clamp bridge-supplied questions to the AskQuestion shape the UI renders.
// Anything without a question text or at least one labeled option is dropped —
// a card the user can't answer would deadlock the turn on a broken picker.
function sanitizeQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const q of raw.slice(0, 4)) {
    if (!q || typeof q !== "object") continue;
    const question = String((q as { question?: unknown }).question ?? "").trim();
    if (!question) continue;
    const options: AskOption[] = (Array.isArray((q as { options?: unknown }).options) ? (q as { options: unknown[] }).options : [])
      .slice(0, 8)
      .flatMap((o) => {
        const label = String((o as { label?: unknown })?.label ?? "").trim();
        if (!label) return [];
        const description = (o as { description?: unknown })?.description;
        return [{ label, ...(typeof description === "string" && description ? { description } : {}) }];
      });
    if (!options.length) continue;
    const header = String((q as { header?: unknown }).header ?? "").trim().slice(0, 24) || "Question";
    out.push({ question, header, options, multiSelect: !!(q as { multiSelect?: unknown }).multiSelect });
  }
  return out;
}

export async function POST(req: NextRequest) {
  let body: { taskId?: string; questions?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const task = body.taskId ? getTask(body.taskId) : undefined;
  if (!task) return NextResponse.json({ error: "unknown task" }, { status: 404 });
  // Asks only make sense mid-turn: with no live turn there is no agent waiting
  // for the outcome, and the parked waiter would have no abort signal to tie to.
  if (!hasTurn(task.id)) return NextResponse.json({ error: "no active turn for this task" }, { status: 409 });

  const questions = sanitizeQuestions(body.questions);
  if (!questions.length) {
    return NextResponse.json({ error: "questions must each have text and at least one labeled option" }, { status: 400 });
  }

  const { askId } = startAskUser(task, questions);
  return NextResponse.json({ ok: true, askId });
}
