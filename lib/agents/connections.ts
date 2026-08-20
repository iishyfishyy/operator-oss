import { getSetting, setSetting } from "../store";
// capabilities.ts, not registry.ts, on purpose: this module only enumerates and
// validates agent IDS — it never drives an agent — and importing the registry
// would drag both agent SDKs into every consumer's graph (the async-external
// poisoning documented in capabilities.ts). Staying SDK-free is what lets
// lib/agentTools.ts resolve a connected agent without poisoning the internal
// agent-tools routes. Pinned by tests/importGraph.test.ts.
import { listAgentIds, isAgentId, DEFAULT_AGENT } from "./capabilities";
import { isBedrockConfigured } from "./claude/provider";

// Per-agent connection state, persisted in the settings table keyed by agent id
// (`agent_conn_<id>`). Distinct from lib/onboarding.ts, which tracks the single
// required first-run Claude connection for the wizard's funnel; this is the
// generic "which agents are connected" record that the task-creation UI reads to
// gray out agents that aren't wired up yet (with a connect CTA), and that the
// generalized /api/agents/[id]/* routes write on a successful login / verify /
// api-key save.
//
// Stored as "method|email|plan" (same compact encoding as onboarding_account),
// where method is "subscription" | "api_key" | "bedrock". An absent key = not connected.

export type AgentConnMethod = "subscription" | "api_key" | "bedrock";

export interface AgentConnection {
  method: AgentConnMethod;
  email: string | null;
  plan: string | null;
}

const key = (agentId: string) => `agent_conn_${agentId}`;

export function getAgentConnection(agentId: string): AgentConnection | null {
  const raw = getSetting(key(agentId));
  const bedrock = agentId === "claude" && isBedrockConfigured();
  if (!raw) return agentId === DEFAULT_AGENT && !bedrock ? legacyClaudeConnection() : null;
  const [method, email, plan] = raw.split("|");
  if (method !== "subscription" && method !== "api_key" && method !== "bedrock") return null;
  // Claude's provider is instance-wide. A connection verified under the other
  // mode is stale after the configuration changes and must be verified again.
  if (bedrock !== (method === "bedrock")) return null;
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
  for (const id of listAgentIds()) if (isAgentConnected(id)) return id;
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
    if (id && isAgentId(id) && isAgentConnected(id)) return id;
  }
  return firstConnectedAgent();
}

export function setAgentConnection(agentId: string, conn: AgentConnection): void {
  setSetting(key(agentId), `${conn.method}|${conn.email ?? ""}|${conn.plan ?? ""}`);
  // A fresh login / verify / api-key save IS the repair — never leave a stale
  // "reconnect me" banner up after the user just did.
  clearAgentAuthBroken(agentId);
}

export function clearAgentConnection(agentId: string): void {
  setSetting(key(agentId), null);
  // Disconnected on purpose: the agent now reads as "not connected", which the
  // UI already explains — a broken-connection banner on top would be noise.
  clearAgentAuthBroken(agentId);
}

// ---------- broken-connection flag (credentials died AFTER connecting) ----------
// `agent_conn_<id>` says "this agent was wired up"; it can't say "and it just
// stopped working". An expired OAuth session leaves the connection record intact
// while every turn fails, so the runner records the failure here
// (lib/runner.ts, classified by lib/authFailure.ts) and the app surfaces it
// instance-wide instead of only inside the task that happened to run first.
// Stored as "<epoch ms>|<reason>" — reason may itself contain "|", so only the
// first separator is split on. Cleared by any successful turn or reconnect.

export interface AgentAuthBroken {
  /** When the failure was first seen (epoch ms). */
  at: number;
  /** The provider's own error text, so the UI can show what actually broke. */
  reason: string;
}

const brokenKey = (agentId: string) => `agent_auth_broken_${agentId}`;

export function getAgentAuthBroken(agentId: string): AgentAuthBroken | null {
  const raw = getSetting(brokenKey(agentId));
  if (!raw) return null;
  const sep = raw.indexOf("|");
  const at = Number(sep === -1 ? raw : raw.slice(0, sep));
  return { at: Number.isFinite(at) ? at : 0, reason: sep === -1 ? "" : raw.slice(sep + 1) };
}

/**
 * Record that this agent's credentials are dead. Returns true only the FIRST
 * time (the flag was previously clear), so callers can publish/announce once per
 * outage rather than on every failing turn — the `at` timestamp is preserved
 * across repeats so the banner can say how long it's been broken.
 */
export function markAgentAuthBroken(agentId: string, reason: string, at: number): boolean {
  const prev = getAgentAuthBroken(agentId);
  setSetting(brokenKey(agentId), `${prev?.at ?? at}|${reason}`);
  return !prev;
}

/** Clear the flag. Returns true if it was actually set (i.e. this healed it). */
export function clearAgentAuthBroken(agentId: string): boolean {
  if (!getSetting(brokenKey(agentId))) return false;
  setSetting(brokenKey(agentId), null);
  return true;
}
