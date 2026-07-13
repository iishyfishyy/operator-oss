import { NextResponse } from "next/server";
import { getDriverStrict } from "@/lib/agents/registry";
import { setAgentConnection, clearAgentConnection } from "@/lib/agents/connections";

export const dynamic = "force-dynamic";

// The "I have an API key instead" alternative to the subscription login, driven
// by the driver's optional apiKey surface (lib/agents/types.ts → AgentApiKeyAuth,
// backed by lib/anthropic-key.ts / lib/openai-key.ts). Stores the key in the
// instance env (persisted to a 0600 file on the volume) so the agent bills
// per-token against it; the Verify step then proves it actually works.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const driver = getDriverStrict(id);
  if (!driver) return NextResponse.json({ error: "unknown agent" }, { status: 404 });
  if (!driver.apiKey) return NextResponse.json({ error: `${driver.label} has no API-key path` }, { status: 400 });

  const { key } = (await req.json()) as { key?: string };
  if (!key || !key.trim()) return NextResponse.json({ error: "missing key" }, { status: 400 });
  if (!driver.apiKey.looksValid(key)) {
    return NextResponse.json({ error: `that doesn't look like a valid key (expected ${driver.apiKey.hint})` }, { status: 400 });
  }
  driver.apiKey.set(key);
  setAgentConnection(id, { method: "api_key", email: null, plan: "API" });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const driver = getDriverStrict(id);
  if (!driver) return NextResponse.json({ error: "unknown agent" }, { status: 404 });
  driver.apiKey?.clear();
  clearAgentConnection(id);
  return NextResponse.json({ ok: true });
}
