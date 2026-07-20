import { NextResponse, type NextRequest } from "next/server";
import { takeAskOutcome } from "@/lib/asks";

export const dynamic = "force-dynamic";

// Poll target for the stdio MCP bridge's ask_user tool: returns the settled
// outcome of an ask started via the sibling endpoint, or pending while the user
// is still deciding. Instant check + client-side sleep (no long-held request —
// undici's default header timeout would kill a multi-minute hold anyway).
// Outcomes are take-once (lib/asks.ts), which is safe on the loopback hop.
export async function POST(req: NextRequest) {
  let body: { taskId?: string; askId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.taskId || !body.askId) {
    return NextResponse.json({ error: "taskId and askId are required" }, { status: 400 });
  }
  const text = takeAskOutcome(body.taskId, body.askId);
  return NextResponse.json(text === null ? { status: "pending" } : { status: "done", text });
}
