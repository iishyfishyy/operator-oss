import { NextResponse } from "next/server";
import { getDriverStrict } from "@/lib/agents/registry";
import { getAgentConnection, setAgentConnection } from "@/lib/agents/connections";
import { track } from "@/lib/analytics";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Prove an agent's connection works by running a real one-shot test turn through
// the same binary the driver drives — a green result means real turns will work,
// not just that credentials exist on disk. Agent-scoped mirror of
// app/api/claude/verify; persists the per-agent connection record so the
// task-creation UI stops graying the agent out.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const driver = getDriverStrict(id);
  if (!driver) return NextResponse.json({ error: "unknown agent" }, { status: 404 });

  const status = await driver.authStatus();
  const turn = await driver.verify();

  // The turn is the real proof (it can pass even when `status` is terse, e.g. on
  // the API-key path); status fills in the friendly "Connected as …".
  const connected = turn.ok;
  if (connected) {
    // Preserve the method already on record (api_key vs subscription) if any;
    // default to subscription for a first-time verify with no prior record.
    const method = getAgentConnection(id)?.method ?? (status.plan === "API" ? "api_key" : "subscription");
    setAgentConnection(id, { method, email: status.email, plan: status.plan });
    track("agent_connected", { agent: id, plan: status.plan, method: status.method });
  } else {
    track("agent_connect_failed", { agent: id, error: (turn.error || status.error || "could not reach agent").slice(0, 500) });
  }

  return NextResponse.json({
    connected,
    email: status.email,
    plan: status.plan,
    method: status.method,
    error: connected ? null : turn.error || status.error || `could not reach ${driver.label}`,
  });
}
