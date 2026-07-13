import { NextResponse } from "next/server";
import { setApiKey, clearApiKey, looksLikeApiKey } from "@/lib/anthropic-key";
import { setOnboardingMethod, setOnboardingAccount } from "@/lib/onboarding";
import { setAgentConnection, clearAgentConnection } from "@/lib/agents/connections";

export const dynamic = "force-dynamic";

// The "I have an API key instead" alternative to the subscription login. Stores
// the key in the instance env (persisted to a 0600 file on the volume — see
// lib/anthropic-key.ts) so the SDK bills per-token against it. The wizard's
// Verify step then proves it actually works.
export async function POST(req: Request) {
  const { key } = (await req.json()) as { key?: string };
  if (!key || !key.trim()) return NextResponse.json({ error: "missing key" }, { status: 400 });
  if (!looksLikeApiKey(key)) {
    return NextResponse.json({ error: "that doesn't look like an Anthropic API key (expected sk-ant-…)" }, { status: 400 });
  }
  setApiKey(key);
  setOnboardingMethod("api_key");
  setOnboardingAccount(null, "API");
  setAgentConnection("claude", { method: "api_key", email: null, plan: "API" });
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  clearApiKey();
  clearAgentConnection("claude");
  return NextResponse.json({ ok: true });
}
