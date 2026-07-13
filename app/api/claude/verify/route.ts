import { NextResponse } from "next/server";
import { getDriver } from "@/lib/agents/registry";
import { setOnboardingAccount, getOnboarding } from "@/lib/onboarding";
import { getAgentConnection, setAgentConnection } from "@/lib/agents/connections";
import { track } from "@/lib/analytics";

export const dynamic = "force-dynamic";

// The wizard's Verify step. Reads the resolved account/plan and runs a one-shot
// test turn through the same `claude` binary the SDK drives, so a green result
// means real turns will work — not just that credentials exist on disk.
export async function POST() {
  const driver = getDriver("claude");
  const status = await driver.authStatus();
  const turn = await driver.verify();

  // The turn is the real proof (it can pass even when `auth status` is terse,
  // e.g. on the API-key path); status fills in the friendly "Connected as …".
  const connected = turn.ok;
  if (connected) {
    setOnboardingAccount(status.email, status.plan);
    // Mirror into the generic per-agent connection record so the task-creation
    // gating (GET /api/agents) sees Claude as connected without a re-verify.
    const method = getAgentConnection("claude")?.method ?? (status.plan === "API" ? "api_key" : "subscription");
    setAgentConnection("claude", { method, email: status.email, plan: status.plan });
  }

  // Critical onboarding-funnel step. Emitted server-side so it's reliable and
  // carries the failure reason when the connection can't produce a real turn.
  if (connected) {
    track("claude_connected", { plan: status.plan, method: status.method }, { setPerson: { claude_plan: status.plan } });
    // Funnel step (first run only): the wizard's Verify test turn passed.
    // Later re-verifies from Settings still emit claude_connected above.
    if (!getOnboarding().complete)
      track("onboarding_step_completed", { step: "verify_turn", method: status.method });
  } else {
    track("claude_connect_failed", { error: (turn.error || status.error || "could not reach Claude").slice(0, 500) });
  }

  return NextResponse.json({
    connected,
    email: status.email,
    plan: status.plan,
    method: status.method,
    error: connected ? null : turn.error || status.error || "could not reach Claude",
  });
}
