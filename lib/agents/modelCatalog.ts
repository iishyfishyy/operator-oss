// SDK-free cache shared by HTTP discovery and synchronous context-window lookups.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { DB_DIR, CLAUDE_CLI_PATH, CODEX_CLI_PATH } from "../config";
import type { AgentModelOption } from "./types";

export type DiscoveredModels = { models: AgentModelOption[]; defaultModel?: string };
export type CatalogStatus = { source: "live" | "cached" | "fallback" | "configured"; updatedAt: number | null; error?: string };
type Entry = DiscoveredModels & { key: string; updatedAt: number; attemptedAt: number; error?: string };
const globals = globalThis as typeof globalThis & { __modelCatalog?: Map<string, Entry>; __modelDiscovery?: Map<string, Promise<void>>; __modelCatalogRevisions?: Map<string, number> };
const entries = globals.__modelCatalog ??= new Map();
const pending = globals.__modelDiscovery ??= new Map();
const revisions = globals.__modelCatalogRevisions ??= new Map();
const TTL = 60 * 60 * 1000;
const RETRY = 60 * 1000;
export function invalidateCatalog(agent: string): void {
  revisions.set(agent, (revisions.get(agent) ?? 0) + 1);
  entries.delete(agent);
  try { fs.unlinkSync(fileFor(agent)); } catch { /* absent */ }
}
const stamp = (file: string) => { try { const s = fs.statSync(file); return [file, s.mtimeMs, s.size]; } catch { return [file]; } };
function identity(agent: string): string {
  const home = agent === "claude" ? process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude") : process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const files = agent === "claude" ? ["settings.json", ".credentials.json"] : ["config.toml", "auth.json"];
  const env = Object.entries(process.env).filter(([k]) => /^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|AWS_)/.test(k)).sort();
  // Only the digest is persisted, never credentials or configuration contents.
  return createHash("sha256").update(JSON.stringify([DB_DIR, env, files.map(f => stamp(path.join(home, f))), stamp(agent === "claude" ? CLAUDE_CLI_PATH : CODEX_CLI_PATH || path.join(process.cwd(), "node_modules/@openai/codex/package.json"))])).digest("hex");
}
const fileFor = (agent: string) => path.join(DB_DIR, `model-catalog-${agent}.json`);
export function validModels(models: unknown): models is AgentModelOption[] {
  return Array.isArray(models) && models.length > 0 && models.length <= 500 && models.every(m => m && typeof m.value === "string" && m.value.length > 0 && m.value.length <= 2048 && !/[\x00-\x1f\x7f]/.test(m.value) && typeof m.label === "string" && typeof m.sub === "string" && Number.isFinite(m.contextWindow) && m.contextWindow > 0);
}
function entryFor(agent: string): Entry | undefined {
  const key = identity(agent);
  let entry = entries.get(agent);
  if (entry?.key === key) return entry;
  try {
    const saved = JSON.parse(fs.readFileSync(fileFor(agent), "utf8"));
    if (saved.key === key && validModels(saved.models) && Number.isFinite(saved.updatedAt)) entry = { ...saved, attemptedAt: 0 };
    else entry = undefined;
  } catch { entry = undefined; }
  if (entry) entries.set(agent, entry); else entries.delete(agent);
  return entry;
}
export function cachedModels(agent: string): DiscoveredModels | undefined {
  const e = entryFor(agent);
  return e && validModels(e.models) ? { models: e.models, defaultModel: e.defaultModel } : undefined;
}
export function catalogStatus(agent: string): CatalogStatus {
  const e = entryFor(agent);
  return { source: e?.updatedAt ? (e.error || Date.now() - e.updatedAt >= TTL ? "cached" : "live") : "fallback", updatedAt: e?.updatedAt || null, ...(e?.error ? { error: e.error } : {}) };
}
export async function refreshCatalog(agent: string, discover: () => Promise<DiscoveredModels>, force = false): Promise<void> {
  const key = identity(agent);
  const revision = revisions.get(agent) ?? 0;
  const flightKey = `${agent}:${key}:${revision}`;
  const flight = pending.get(flightKey);
  if (flight) return flight;
  const old = entryFor(agent);
  if (!force && old && (Date.now() - old.attemptedAt < RETRY || (!old.error && Date.now() - old.updatedAt < TTL))) return;
  const run = (async () => {
    try {
      const result = await discover();
      if (!validModels(result.models)) throw new Error("No exact models returned");
      if (identity(agent) !== key || (revisions.get(agent) ?? 0) !== revision) return; // credentials/config changed during discovery
      const entry: Entry = { ...result, key, updatedAt: Date.now(), attemptedAt: Date.now() };
      entries.set(agent, entry);
      try {
        fs.mkdirSync(DB_DIR, { recursive: true });
        const temp = `${fileFor(agent)}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(entry), { mode: 0o600 });
        fs.renameSync(temp, fileFor(agent));
      } catch { /* An unwritable cache must not discard a successful discovery. */ }
    } catch {
      if (identity(agent) === key && (revisions.get(agent) ?? 0) === revision) entries.set(agent, { ...(old ?? { key, models: [], updatedAt: 0 }), attemptedAt: Date.now(), error: "Could not refresh models. Check the agent connection and CLI version, then retry." });
    }
  })();
  pending.set(flightKey, run);
  try { await run; } finally { pending.delete(flightKey); }
}
