import type { AgentModelOption, AgentPickerOption } from "./types";
import type { DiscoveredModels } from "./modelCatalog";

// Claude Code reports effort levels as bare names (no descriptions); keep them
// verbatim. supportsEffort false / no list = the model takes no effort ([]).
function claudeEfforts(row: Record<string, unknown>): AgentPickerOption[] {
  if (row.supportsEffort !== true || !Array.isArray(row.supportedEffortLevels)) return [];
  return row.supportedEffortLevels.filter((l): l is string => typeof l === "string" && !!l).map(l => ({ value: l, label: l, sub: "" }));
}

// Model names come from the CLI's own text. Claude Code rows lead their
// description with the versioned name ("Opus 5.5 with 1M context · Most capable
// …"), while displayName is often the bare family ("Fable") or describes the
// alias row ("Default (recommended)"). Use the description's head when it names
// a version, then a versioned displayName on an exact-ID row, and only then a
// name derived from the ID itself.
function claudeLabel(row: Record<string, unknown>, id: string): { label: string; sub: string } {
  const desc = typeof row.description === "string" ? row.description : "";
  const [head, ...rest] = desc.split(" · ");
  if (rest.length && /^[A-Z][A-Za-z]* \d/.test(head)) return { label: head, sub: rest.join(" · ") };
  if (row.value === id && typeof row.displayName === "string" && /\d/.test(row.displayName)) return { label: row.displayName, sub: desc };
  const parts = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?=-|\[|$))?/);
  const label = parts ? `${parts[1][0].toUpperCase()}${parts[1].slice(1)} ${parts[2]}${parts[3] ? `.${parts[3]}` : ""}${id.includes("[1m]") ? " (1M)" : ""}` : id;
  return { label, sub: desc };
}

// Never turn display names into routing IDs. Older Claude CLIs may provide only
// aliases; skip those and let the cache/fallback cover the unsupported protocol.
export function claudeModels(rows: unknown[], fallback: AgentModelOption[]): DiscoveredModels {
  const models: AgentModelOption[] = [];
  let defaultModel: string | undefined;
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    if (!row || typeof row !== "object") continue;
    const id = typeof row.resolvedModel === "string" ? row.resolvedModel : row.value;
    if (typeof id !== "string" || !/^claude-[a-z]+-\d/.test(id)) continue;
    if (row.value === "default") defaultModel = id;
    if (models.some(m => m.value === id)) continue;
    const known = fallback.find(m => m.value === id);
    models.push({ value: id, ...claudeLabel(row, id), contextWindow: known?.contextWindow ?? (id.includes("[1m]") ? 1_000_000 : 200_000), group: "Available models", reasoningEfforts: claudeEfforts(row) });
  }
  return { models, defaultModel };
}

// Codex reports each level with its own description and a per-model default.
// "minimal" is dropped even if a CLI lists it: the API rejects it for any
// tool-using turn, which every Operator turn is.
// A CLI too old to report levels leaves them unknown (the agent-wide list).
function codexEfforts(row: Record<string, unknown>): { reasoningEfforts?: AgentPickerOption[]; defaultReasoning?: string } {
  if (!Array.isArray(row.supportedReasoningEfforts)) return {};
  const reasoningEfforts = row.supportedReasoningEfforts
    .map(e => e as Record<string, unknown>)
    .filter(e => e && typeof e.reasoningEffort === "string" && e.reasoningEffort && e.reasoningEffort !== "minimal")
    .map(e => ({ value: e.reasoningEffort as string, label: e.reasoningEffort as string, sub: typeof e.description === "string" ? e.description : "" }));
  const def = typeof row.defaultReasoningEffort === "string" ? row.defaultReasoningEffort : undefined;
  return { reasoningEfforts, ...(def ? { defaultReasoning: def } : {}) };
}

export function codexModels(rows: unknown[], fallback: AgentModelOption[]): DiscoveredModels {
  const models: AgentModelOption[] = [];
  let defaultModel: string | undefined;
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    if (!row || typeof row !== "object" || row.hidden === true || typeof row.model !== "string" || !row.model) continue;
    if (row.isDefault === true) defaultModel = row.model;
    if (models.some(m => m.value === row.model)) continue;
    models.push({ value: row.model, label: typeof row.displayName === "string" ? row.displayName : row.model, sub: typeof row.description === "string" ? row.description : "", contextWindow: fallback.find(m => m.value === row.model)?.contextWindow ?? 272_000, group: "Available models", ...codexEfforts(row) });
  }
  return { models, defaultModel };
}
