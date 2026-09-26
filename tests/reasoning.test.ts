import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { init, migrate } from "../lib/db";
import { agentReasoningOptions, resolveReasoning, LEGACY_REASONING } from "@/lib/agents/reasoning";
import { codexEffort } from "@/lib/agents/codex/driver";
import { claudeEffort } from "@/lib/agents/claude/driver";
import { CODEX_CAPABILITIES } from "@/lib/agents/codex/capabilities";
import { CLAUDE_CAPABILITIES } from "@/lib/agents/claude/capabilities";
import { invalidateCatalog } from "@/lib/agents/modelCatalog";
import type { AgentModelOption } from "@/lib/agents/types";

// Reasoning levels are the CLIs' own effort names, per model, passed through
// unchanged — never Operator presets.
const lvl = (...ls: string[]) => ls.map((l) => ({ value: l, label: l, sub: "" }));
const models: AgentModelOption[] = [
  { value: "big", label: "Big", sub: "", contextWindow: 1, reasoningEfforts: lvl("low", "medium", "high", "xhigh", "max") },
  { value: "mid", label: "Mid", sub: "", contextWindow: 1, reasoningEfforts: lvl("low", "medium", "high", "ultra") },
  { value: "tiny", label: "Tiny", sub: "", contextWindow: 1, reasoningEfforts: [] },
  { value: "old", label: "Old", sub: "", contextWindow: 1 },
];

describe("resolveReasoning", () => {
  it("passes a supported CLI level through verbatim", () => {
    expect(resolveReasoning("max", models, "big")).toBe("max");
    expect(resolveReasoning("ultra", models, "mid")).toBe("ultra");
  });
  it("falls back to the CLI default (undefined) for a level the model doesn't accept", () => {
    expect(resolveReasoning("xhigh", models, "mid")).toBeUndefined();
    expect(resolveReasoning("low", models, "tiny")).toBeUndefined();
  });
  it("passes through for unknown / level-less models and inherits on null", () => {
    expect(resolveReasoning("xhigh", models, "custom-id")).toBe("xhigh");
    expect(resolveReasoning("xhigh", models, "old")).toBe("xhigh");
    expect(resolveReasoning("xhigh", models, null)).toBe("xhigh");
    expect(resolveReasoning(null, models, "big")).toBeUndefined();
  });
  it("maps pre-CLI presets to the level they always sent", () => {
    expect(LEGACY_REASONING).toEqual({ off: "low", think: "medium", think_hard: "high", ultrathink: "xhigh" });
    expect(resolveReasoning("think_hard", models, "big")).toBe("high");
  });
});

describe("agentReasoningOptions", () => {
  it("unions per-model levels in first-seen order", () => {
    expect(agentReasoningOptions(models, []).map((o) => o.value)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });
  it("uses the fallback when no model reports levels", () => {
    expect(agentReasoningOptions([models[3]], lvl("low"))).toEqual(lvl("low"));
  });
});

describe("driver effort wiring (built-in catalog)", () => {
  afterEach(() => { invalidateCatalog("codex"); invalidateCatalog("claude"); });
  it("codex sends the CLI level as model_reasoning_effort, never 'minimal'", () => {
    invalidateCatalog("codex");
    expect(codexEffort("ultra", "gpt-6-astra")).toEqual({ modelReasoningEffort: "ultra" });
    expect(codexEffort("minimal", "gpt-6-astra")).toEqual({});
    expect(codexEffort(null, null)).toEqual({});
    expect(CODEX_CAPABILITIES.reasoningOptions.map((o) => o.value)).not.toContain("minimal");
  });
  it("claude sends the CLI level as effort and skips models without effort", () => {
    invalidateCatalog("claude");
    expect(claudeEffort("max", "claude-opus-5-5")).toEqual({ effort: "max" });
    expect(claudeEffort("high", "claude-haiku-4-5-20251001")).toEqual({});
    expect(CLAUDE_CAPABILITIES.reasoningOptions.map((o) => o.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("legacy preset migration", () => {
  let db: Database.Database | undefined;
  afterEach(() => { db?.close(); db = undefined; });
  it("rewrites stored presets on tasks and defaults, idempotently", () => {
    db = new Database(":memory:");
    init(db);
    db.prepare("INSERT INTO projects (id, name, icon, repo_path, port, position, created_at) VALUES ('p', 'P', '?', '', 0, 0, 0)").run();
    const addTask = db.prepare("INSERT INTO tasks (id, project_id, title, reasoning, created_at, updated_at) VALUES (?, 'p', 't', ?, 0, 0)");
    for (const [id, r] of [["a", "off"], ["b", "think"], ["c", "think_hard"], ["d", "ultrathink"], ["e", "max"], ["f", null]]) addTask.run(id, r);
    const set = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
    set.run("default_reasoning", "think");
    set.run("default_reasoning:codex", "ultrathink");
    set.run("recap_mode", "off");
    migrate(db);
    migrate(db);
    const tasks = Object.fromEntries((db.prepare("SELECT id, reasoning FROM tasks WHERE project_id = 'p'").all() as { id: string; reasoning: string | null }[]).map((t) => [t.id, t.reasoning]));
    expect(tasks).toEqual({ a: "low", b: "medium", c: "high", d: "xhigh", e: "max", f: null });
    const get = (k: string) => (db!.prepare("SELECT value FROM settings WHERE key = ?").get(k) as { value: string }).value;
    expect(get("default_reasoning")).toBe("medium");
    expect(get("default_reasoning:codex")).toBe("xhigh");
    expect(get("recap_mode")).toBe("off");
  });
});
