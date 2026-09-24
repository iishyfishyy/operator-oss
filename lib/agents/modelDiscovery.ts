import type { AgentModelOption } from "./types";
import type { DiscoveredModels } from "./modelCatalog";

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
    const parts = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?=-|\[|$))?/);
    const label = parts ? `${parts[1][0].toUpperCase()}${parts[1].slice(1)} ${parts[2]}${parts[3] ? `.${parts[3]}` : ""}${id.includes("[1m]") ? " (1M)" : ""}` : id;
    models.push({ value: id, label, sub: typeof row.description === "string" ? row.description : "", contextWindow: known?.contextWindow ?? (id.includes("[1m]") ? 1_000_000 : 200_000), group: "Available models" });
  }
  return { models, defaultModel };
}
export function codexModels(rows: unknown[], fallback: AgentModelOption[]): DiscoveredModels {
  const models: AgentModelOption[] = [];
  let defaultModel: string | undefined;
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    if (!row || typeof row !== "object" || row.hidden === true || typeof row.model !== "string" || !row.model) continue;
    if (row.isDefault === true) defaultModel = row.model;
    if (models.some(m => m.value === row.model)) continue;
    models.push({ value: row.model, label: typeof row.displayName === "string" ? row.displayName : row.model, sub: typeof row.description === "string" ? row.description : "", contextWindow: fallback.find(m => m.value === row.model)?.contextWindow ?? 272_000, group: "Available models" });
  }
  return { models, defaultModel };
}
