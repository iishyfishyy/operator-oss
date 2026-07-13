import { NextResponse } from "next/server";
import { getDriver } from "@/lib/agents/registry";
import { setOnboardingMethod, setOnboardingAccount } from "@/lib/onboarding";
import { setAgentConnection } from "@/lib/agents/connections";

export const dynamic = "force-dynamic";

// The wizard's "Connect Claude" subscription flow, via the Claude driver's
// auth surface (backed by lib/claude-auth.ts). POST starts (or rejoins) the
// headless `claude auth login` and resolves once the authorize URL is known;
// the UI then polls GET until the user pastes the code (see ./code) and the
// login lands; DELETE abandons it. The session lives server-side so a reload
// mid-login picks the same attempt back up.

export async function POST() {
  const s = await getDriver("claude").startLogin();
  if (s.status === "success") persist(s);
  return NextResponse.json(s);
}

export async function GET() {
  const s = getDriver("claude").getLogin();
  if (s?.status === "success") persist(s);
  return NextResponse.json(s ?? { status: "idle", url: null, email: null, plan: null, error: null, log: "" });
}

export async function DELETE() {
  getDriver("claude").cancelLogin();
  return NextResponse.json({ ok: true });
}

function persist(s: { email: string | null; plan: string | null }) {
  setOnboardingMethod("subscription");
  setOnboardingAccount(s.email, s.plan);
  setAgentConnection("claude", { method: "subscription", email: s.email, plan: s.plan });
}
