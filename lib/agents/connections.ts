import { getSetting, setSetting } from "../store";
import { listDrivers, getDriverStrict, DEFAULT_AGENT } from "./registry";

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
  if (!raw) return agentId === DEFAULT_AGENT ? legacyClaudeConnection() : null;
  const [method, email, plan] = raw.split("|");
  if (method !== "subscription" && method !== "api_key") return null;
  return { method, email: email || null, plan: plan || null };
}

// Pre-seam instances recorded their first-run Claude connection only in the
// onboarding keys (agent_conn_claude didn't exist yet, and is only re-written on
// the next login/verify). Treat that record as a live Claude connection so
// connected-first resolution and the /api/agents `connected` flag never regress
// a legacy instance that has been running Claude turns all along.
function legacyClaudeConnection(): AgentConnection | null {
  const method = getSetting("onboarding_method");
  if (method !== "subscription" && method !== "api_key") return null;
  const acct = getSetting("onboarding_account");
  const [email, plan] = acct ? acct.split("|") : [null, null];
  return { method, email: email || null, plan: plan || null };
}

/** Whether this agent has a working connection on record (login/verify/api-key). */
export function isAgentConnected(agentId: string): boolean {
  return getAgentConnection(agentId) !== null;
}

/** The first connected agent in registry order, or null when none is connected. */
export function firstConnectedAgent(): string | null {
  for (const d of listDrivers()) if (isAgentConnected(d.id)) return d.id;
  return null;
}

/**
 * Resolve the first CONNECTED agent from an ordered preference list (unknown ids
 * and unconnected agents are skipped), falling back to any connected agent at
 * all. Returns null only when no agent is connected — callers turn that into an
 * actionable "connect an agent" error rather than driving a dead CLI.
 */
export function resolveConnectedAgent(preferred: (string | null | undefined)[]): string | null {
  for (const id of preferred) {
    if (id && getDriverStrict(id) && isAgentConnected(id)) return id;
  }
  return firstConnectedAgent();
}

export function setAgentConnection(agentId: string, conn: AgentConnection): void {
  setSetting(key(agentId), `${conn.method}|${conn.email ?? ""}|${conn.plan ?? ""}`);
}

export function clearAgentConnection(agentId: string): void {
  setSetting(key(agentId), null);
}
