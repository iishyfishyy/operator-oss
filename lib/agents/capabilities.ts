// SDK-free capability lookup — the piece of the driver registry that low-level
// modules may import.
//
// Why this exists: the agent SDKs (@anthropic-ai/claude-agent-sdk,
// @openai/codex-sdk) are serverExternalPackages, which Turbopack emits as ASYNC
// externals — and async-ness propagates to every transitive importer. A module
// compiled async but imported from a non-async route entry gets a Promise
// instead of its namespace, and every export reads back undefined at runtime
// ("(0, C.publicServiceHost) is not a function" — this took down
// /api/services/grant and the boot services-restore ping in prod). lib/store.ts
// only ever needed the drivers' capability DATA (context windows), so that data
// lives here, importable without dragging a single SDK into the graph.
//
// Rule: nothing in this file's import graph may reach a driver module or an
// agent SDK. tests/importGraph.test.ts pins this.

import type { AgentCapabilities } from "./types";
import { claudeCapabilities } from "./claude/capabilities";
import { CODEX_CAPABILITIES } from "./codex/capabilities";
import { MOCK_CAPABILITIES } from "./mock/capabilities";

export const DEFAULT_AGENT = "claude";

// Thunks, not values: Claude's descriptor depends on instance config (its model
// list is Bedrock-shaped when Claude routes through AWS), so it's computed per
// read. The others are static and just close over their constant.
const CAPABILITIES: Record<string, () => AgentCapabilities> = {
  claude: () => claudeCapabilities(),
  codex: () => CODEX_CAPABILITIES,
};

// The deterministic e2e agent, under the same env gate registry.ts uses. It has
// to be here and not only there: this file backs listAgentIds()/isAgentId(), so
// without it the mock is connectable but invisible to every id-level lookup —
// firstConnectedAgent() skips it, and completeOnboarding() then finds nothing to
// adopt on a mock-only first run. Read at import time like the rest of this
// module; the env is set before the server boots (e2e/env.ts).
if (process.env.ORCH_E2E_MOCK_AGENT === "1") CAPABILITIES.mock = () => MOCK_CAPABILITIES;

/** Every registered agent id, in registry order — the SDK-free half of
 * listDrivers(), for callers that only need to enumerate/validate ids
 * (connection state, connected-first resolution) rather than drive an agent. */
export function listAgentIds(): string[] {
  return Object.keys(CAPABILITIES);
}

/** Whether `id` is a registered agent — the SDK-free getDriverStrict() null check. */
export function isAgentId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, id);
}

/** Capability descriptor by agent id; unknown/null ids fall back to the default
 * agent (same forgiving resolution as getDriver — a hand-edited tasks.agent row
 * should still resolve to something). */
export function getCapabilities(id: string | null | undefined): AgentCapabilities {
  return ((id && CAPABILITIES[id]) || CAPABILITIES[DEFAULT_AGENT])();
}

// Context window for an (agent, model) pair, from the capability descriptor
// (models[].contextWindow) — so a Codex task's ~272k window and a Fable task's
// 1M window are both correct, with no per-agent table here. Unknown/inherited
// (null) model falls back to the widest window the agent offers, then a
// conservative constant. Mirrored in app/orchestrator/format.ts
// (contextWindowOf) so the live SSE update matches the server.
const DEFAULT_CONTEXT_WINDOW = 200_000;
export function modelContextWindow(agent: string | null | undefined, model: string | null | undefined): number {
  const models = getCapabilities(agent).models;
  if (model) {
    const hit = models.find((m) => m.value === model);
    if (hit) return hit.contextWindow;
    // Provider-native ids and inference-profile ARNs are intentionally open
    // ended. Only claim 1M when the string itself identifies that mode/model;
    // otherwise use the conservative standard window rather than the widest
    // catalog entry (which would make a 200k custom model look nearly empty).
    const id = model.toLowerCase();
    if (id.includes("[1m]") || id.includes("claude-sonnet-5") || id.includes("claude-fable-5")) return 1_000_000;
    return DEFAULT_CONTEXT_WINDOW;
  }
  const widest = models.reduce((mx, m) => Math.max(mx, m.contextWindow), 0);
  return widest || DEFAULT_CONTEXT_WINDOW;
}
