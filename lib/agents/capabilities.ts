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
import { CLAUDE_CAPABILITIES } from "./claude/capabilities";
import { CODEX_CAPABILITIES } from "./codex/capabilities";

export const DEFAULT_AGENT = "claude";

const CAPABILITIES: Record<string, AgentCapabilities> = {
  claude: CLAUDE_CAPABILITIES,
  codex: CODEX_CAPABILITIES,
};

/** Capability descriptor by agent id; unknown/null ids fall back to the default
 * agent (same forgiving resolution as getDriver — a hand-edited tasks.agent row
 * should still resolve to something). */
export function getCapabilities(id: string | null | undefined): AgentCapabilities {
  return (id && CAPABILITIES[id]) || CAPABILITIES[DEFAULT_AGENT];
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
  }
  const widest = models.reduce((mx, m) => Math.max(mx, m.contextWindow), 0);
  return widest || DEFAULT_CONTEXT_WINDOW;
}
