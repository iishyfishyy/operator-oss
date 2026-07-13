import { NextResponse } from "next/server";
import { getDriverStrict } from "@/lib/agents/registry";
import { setAgentConnection } from "@/lib/agents/connections";

export const dynamic = "force-dynamic";

// Hand the pasted authorization code to the waiting login (paste-code drivers
// like Claude). Device-auth drivers like Codex treat this as a no-op — the user
// enters the code in the browser — and the UI just keeps polling GET
// /api/agents/[id]/login until the flow lands on its own.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const driver = getDriverStrict(id);
  if (!driver) return NextResponse.json({ error: "unknown agent" }, { status: 404 });
  const { code } = (await req.json()) as { code?: string };
  if (!code || !code.trim()) return NextResponse.json({ error: "missing code" }, { status: 400 });
  const s = await driver.submitLoginCode(code);
  if (s.status === "success") setAgentConnection(id, { method: "subscription", email: s.email, plan: s.plan });
  return NextResponse.json(s);
}
