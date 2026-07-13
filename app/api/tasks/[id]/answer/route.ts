import { getTask } from "@/lib/store";
import { submitAnswer } from "@/lib/asks";
import type { AskAnswers } from "@/lib/types";

export const dynamic = "force-dynamic";

// Deliver the user's answer to a Claude turn parked on an AskUserQuestion.
// `resolved: true`  → the live turn was waiting and will continue in its stream.
// `resolved: false` → nothing was waiting (e.g. the turn was torn down by a page
//   reload); the client resumes the session with the answer as a normal reply.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getTask(id)) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });

  const { askId, answers } = (await req.json()) as { askId?: string; answers?: AskAnswers };
  if (!askId || !Array.isArray(answers)) {
    return new Response(JSON.stringify({ error: "askId and answers are required" }), { status: 400 });
  }

  const resolved = submitAnswer(id, askId, answers);
  return Response.json({ resolved });
}
