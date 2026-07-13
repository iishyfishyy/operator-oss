import { NextResponse } from "next/server";
import { getDriver } from "@/lib/agents/registry";
import { setOnboardingMethod, setOnboardingAccount } from "@/lib/onboarding";
import { setAgentConnection } from "@/lib/agents/connections";

export const dynamic = "force-dynamic";

// Hand the pasted authorization code to the waiting `claude auth login` prompt.
// Returns the (possibly already-resolved) session; the UI keeps polling
// GET /api/claude/login until it flips to success or error.
export async function POST(req: Request) {
  const { code } = (await req.json()) as { code?: string };
  if (!code || !code.trim()) return NextResponse.json({ error: "missing code" }, { status: 400 });
  const s = await getDriver("claude").submitLoginCode(code);
  if (s.status === "success") {
    setOnboardingMethod("subscription");
    setOnboardingAccount(s.email, s.plan);
    setAgentConnection("claude", { method: "subscription", email: s.email, plan: s.plan });
  }
  return NextResponse.json(s);
}
