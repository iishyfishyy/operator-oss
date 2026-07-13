import { getSetting, setSetting } from "../store";

// Per-agent connection state, persisted in the settings table keyed by agent id
// (`agent_conn_<id>`). Distinct from lib/onboarding.ts, which tracks the single
// required first-run Claude connection for the wizard's funnel; this is the
// generic "which agents are connected" record that the task-creation UI reads to
// gray out agents that aren't wired up yet (with a connect CTA), and that the
// generalized /api/agents/[id]/* routes write on a successful login / verify /
// api-key save.
//
// Stored as "method|email|plan" (same compact encoding as onboarding_account),
// where method is "subscription" | "api_key". An absent key = not connected.

export type AgentConnMethod = "subscription" | "api_key";

export interface AgentConnection {
  method: AgentConnMethod;
  email: string | null;
  plan: string | null;
}

const key = (agentId: string) => `agent_conn_${agentId}`;

export function getAgentConnection(agentId: string): AgentConnection | null {
  const raw = getSetting(key(agentId));
  if (!raw) return null;
  const [method, email, plan] = raw.split("|");
  if (method !== "subscription" && method !== "api_key") return null;
  return { method, email: email || null, plan: plan || null };
}

export function setAgentConnection(agentId: string, conn: AgentConnection): void {
  setSetting(key(agentId), `${conn.method}|${conn.email ?? ""}|${conn.plan ?? ""}`);
}

export function clearAgentConnection(agentId: string): void {
  setSetting(key(agentId), null);
}
