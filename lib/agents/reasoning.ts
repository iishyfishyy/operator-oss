// Reasoning levels are the agent CLIs' own effort names (low / medium / high /
// xhigh / max / ultra …), discovered per model and passed through unchanged —
// Operator never renames them. SDK-free so capability readers can import it.

import type { AgentModelOption, AgentPickerOption } from "./types";

// Presets from before levels came from the CLIs. The DB migration rewrites
// stored rows once; resolveReasoning() also maps them so a value written by an
// older build (or a restored backup) still runs as the level it used to send.
export const LEGACY_REASONING: Record<string, string> = {
  off: "low",
  think: "medium",
  think_hard: "high",
  ultrathink: "xhigh",
};

/** Every level any model offers, in first-seen order — the agent-wide list
 *  (Settings defaults, custom model ids). Falls back when no model reports levels. */
export function agentReasoningOptions(models: AgentModelOption[], fallback: AgentPickerOption[]): AgentPickerOption[] {
  const seen = new Map<string, AgentPickerOption>();
  for (const m of models) for (const e of m.reasoningEfforts ?? []) if (!seen.has(e.value)) seen.set(e.value, e);
  return seen.size ? [...seen.values()] : fallback;
}

/**
 * The level to send for a turn, or undefined to let the CLI use its default.
 * A model the catalog knows is checked against its reported levels: a level it
 * doesn't accept (e.g. xhigh kept after switching to a model without it) falls
 * back to the CLI default instead of failing the turn. Unknown models (custom
 * ids) pass the level through as-is.
 */
export function resolveReasoning(level: string | null | undefined, models: AgentModelOption[], model: string | null | undefined): string | undefined {
  if (!level) return undefined;
  const value = LEGACY_REASONING[level] ?? level;
  const efforts = model ? models.find((m) => m.value === model)?.reasoningEfforts : undefined;
  if (efforts && !efforts.some((e) => e.value === value)) return undefined;
  return value;
}
