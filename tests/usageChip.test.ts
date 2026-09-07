// The usage chip used to read "3.8M tok · $4.20" for a session whose actual
// work was a few hundred thousand tokens on a Max plan that billed nothing —
// accurate numbers, terrifying presentation. Two things keep it honest, and
// both are pinned here: the token total is split (cache READS are context
// re-sent every turn at ~10% of the input rate, not work), and a dollar figure
// is only presented as money when the agent is signed in with an API key.
import { describe, it, expect } from "vitest";
import { usageSplit, sessionUsageSplit, costDisplay, usageTooltip, fmtJobCost } from "@/app/orchestrator/format";
import type { AgentInfo, TaskRow } from "@/app/orchestrator/types";
import { CLAUDE_CAPABILITIES } from "@/lib/agents/claude/capabilities";
import { CODEX_CAPABILITIES } from "@/lib/agents/codex/capabilities";
import { addUsage, createProject, createTask, listTasks, updateTask, getTaskUsage, getGenerationUsage } from "@/lib/store";
import { tmpDir } from "./helpers";

// The shape from the investigation: 13k in/out, 240k cache writes, 3.5M reads.
const real: Pick<TaskRow, "total_tokens" | "cache_read_tokens" | "cache_creation_tokens"> = {
  total_tokens: 3_753_000,
  cache_read_tokens: 3_500_000,
  cache_creation_tokens: 240_000,
};

const agent = (over: Partial<AgentInfo>): AgentInfo => ({
  id: "claude", label: "Claude Code", capabilities: CLAUDE_CAPABILITIES, authenticated: true, ...over,
});

describe("usageSplit", () => {
  it("leads with fresh work, not the cache-read-dominated total", () => {
    const s = usageSplit(real);
    expect(s.total).toBe(3_753_000);
    expect(s.cacheRead).toBe(3_500_000);
    expect(s.cacheWrite).toBe(240_000);
    expect(s.inOut).toBe(13_000);
    // The headline: everything the model saw for the first time.
    expect(s.fresh).toBe(253_000);
    // …which is the whole point — a fraction of the raw number.
    expect(s.fresh / s.total).toBeLessThan(0.1);
  });

  it("never goes negative on odd rows (fields absent, buckets over-summed)", () => {
    const legacy = { total_tokens: 500 } as TaskRow;
    expect(usageSplit(legacy)).toMatchObject({ total: 500, fresh: 500, inOut: 500, cacheRead: 0, cacheWrite: 0 });
    const skewed = { total_tokens: 100, cache_read_tokens: 200, cache_creation_tokens: 50 } as TaskRow;
    expect(usageSplit(skewed).inOut).toBe(0);
    expect(usageSplit(skewed).fresh).toBe(0);
  });
});

describe("fmtJobCost", () => {
  it("keeps the point-of-action estimate compact", () => {
    expect(fmtJobCost({ tokens: 38_000, cost_usd: 0.11, source: "project_latest" }))
      .toBe("~38k tokens (~$0.11)");
  });
});

describe("listTasks", () => {
  it("carries the cache buckets, so the split survives a page load", () => {
    const project = createProject({ name: `p-${Math.random().toString(36).slice(2, 8)}`, repo_path: tmpDir() });
    const task = createTask({ project_id: project.id, title: "t", description: "" });
    const turn = { cost_usd: 1, input_tokens: 100, output_tokens: 50, cache_read_tokens: 9_000, cache_creation_tokens: 400 };
    addUsage({ project_id: project.id, task_id: task.id, generation: 1, usage: turn });
    addUsage({ project_id: project.id, task_id: task.id, generation: 1, usage: turn });

    const row = listTasks(project.id).find((t) => t.id === task.id)!;
    expect(row.total_tokens).toBe(19_100);
    expect(row.cache_read_tokens).toBe(18_000);
    expect(row.cache_creation_tokens).toBe(800);
    expect(usageSplit(row).fresh).toBe(1_100);
  });

  // /clear ends generation N and starts N+1 with a fresh context window. The
  // chip leads with what THAT window has spent, so the row carries the current
  // generation's share beside the lifetime total — and the lifetime must keep
  // every earlier generation (it's what the project column sums).
  it("splits the current generation's spend from the task's lifetime spend", () => {
    const project = createProject({ name: `p-${Math.random().toString(36).slice(2, 8)}`, repo_path: tmpDir() });
    const task = createTask({ project_id: project.id, title: "t", description: "" });
    const gen1 = { cost_usd: 2, input_tokens: 1_000, output_tokens: 500, cache_read_tokens: 20_000, cache_creation_tokens: 3_000 };
    const gen2 = { cost_usd: 0.5, input_tokens: 100, output_tokens: 50, cache_read_tokens: 1_000, cache_creation_tokens: 200 };
    addUsage({ project_id: project.id, task_id: task.id, generation: 1, usage: gen1 });
    addUsage({ project_id: project.id, task_id: task.id, generation: 1, usage: gen1 });

    // Right after /clear: generation bumped, nothing spent in the new window yet.
    updateTask(task.id, { generation: 2 });
    let row = listTasks(project.id).find((t) => t.id === task.id)!;
    expect(row.generation).toBe(2);
    expect(row.cost_usd).toBe(4);
    expect(row.total_tokens).toBe(49_000);
    expect(row.session_cost_usd).toBe(0);
    expect(row.session_tokens).toBe(0);
    expect(row.session_cache_read_tokens).toBe(0);
    expect(row.session_cache_creation_tokens).toBe(0);
    expect(sessionUsageSplit(row).fresh).toBe(0);

    // The new window's first turn lands: session = that turn, lifetime = all three.
    addUsage({ project_id: project.id, task_id: task.id, generation: 2, usage: gen2 });
    row = listTasks(project.id).find((t) => t.id === task.id)!;
    expect(row.session_cost_usd).toBe(0.5);
    expect(row.session_tokens).toBe(1_350);
    expect(row.session_cache_read_tokens).toBe(1_000);
    expect(row.session_cache_creation_tokens).toBe(200);
    expect(sessionUsageSplit(row).fresh).toBe(350);
    expect(row.cost_usd).toBe(4.5);
    expect(row.total_tokens).toBe(50_350);
    expect(row.cache_read_tokens).toBe(41_000);
    expect(usageSplit(row).fresh).toBe(9_350);

    // GET /api/tasks/[id] builds the same pair from these two helpers.
    expect(getTaskUsage(task.id)).toMatchObject({ cost_usd: 4.5, total_tokens: 50_350, turns: 3 });
    expect(getGenerationUsage(task.id, 2)).toMatchObject({ cost_usd: 0.5, total_tokens: 1_350, turns: 1 });
    expect(getGenerationUsage(task.id, 1)).toMatchObject({ cost_usd: 4, total_tokens: 49_000, turns: 2 });
  });
});

describe("costDisplay", () => {
  it("calls a subscription figure an equivalent, not a bill", () => {
    const c = costDisplay(agent({ account: { email: "a@b.c", plan: "Max", method: "subscription" } }));
    expect(c).toMatchObject({ show: true, approx: true });
    expect(c.note).toContain("API-price equivalent");
    expect(c.note).toContain("your Max plan");
    expect(c.note).not.toContain("estimated");
  });

  it("keeps the plain billed presentation for an API key", () => {
    const c = costDisplay(agent({ account: { email: null, plan: "API", method: "api_key" } }));
    expect(c).toEqual({ show: true, approx: false, note: "" });
  });

  it("labels Bedrock cost as a client-side estimate", () => {
    const c = costDisplay(agent({ account: { email: null, plan: "AWS", method: "bedrock" } }));
    expect(c).toMatchObject({ show: true, approx: true });
    expect(c.note).toContain("AWS bill is authoritative");
  });

  it("labels a tokens-only driver estimated, and doubly so on a subscription", () => {
    const codex = (over: Partial<AgentInfo>) =>
      costDisplay(agent({ id: "codex", label: "Codex", capabilities: CODEX_CAPABILITIES, ...over }));
    expect(codex({}).note).toBe("estimated from token counts × published API prices");
    expect(codex({}).approx).toBe(true);
    const sub = codex({ account: { email: null, plan: null, method: "subscription" } });
    expect(sub.note).toContain("estimated from token counts");
    expect(sub.note).toContain("your plan");
  });

  it("still shows a cost when the bundle hasn't loaded — but claims nothing about a plan", () => {
    expect(costDisplay(undefined)).toEqual({ show: true, approx: false, note: "" });
  });
});

describe("usageTooltip", () => {
  it("spells out where every token went, and what the dollars mean", () => {
    const sub = costDisplay(agent({ account: { email: null, plan: "Max", method: "subscription" } }));
    const text = usageTooltip(usageSplit(real), 4.2, sub);
    expect(text).toContain("253,000 new tokens");
    expect(text).toContain("13,000 in/out");
    expect(text).toContain("240,000 written to cache");
    expect(text).toContain("3,500,000 cache reads");
    expect(text).toContain("3,753,000 tokens total");
    expect(text).toContain("~$4.20");
    expect(text).toContain("plan quota, not a bill");
  });

  it("drops the cache lines when nothing was cached", () => {
    const text = usageTooltip(usageSplit({ total_tokens: 900, cache_read_tokens: 0, cache_creation_tokens: 0 }), 0, costDisplay(undefined));
    expect(text).toBe("900 new tokens this task: 900 in/out · 0 written to cache");
  });

  it("says 'this task' while there is one session, and adds lifetime once there are more", () => {
    const api = costDisplay(agent({ account: { email: null, plan: "API", method: "api_key" } }));
    const session = usageSplit({ total_tokens: 1_350, cache_read_tokens: 1_000, cache_creation_tokens: 200 });
    // Single generation: session == lifetime, so no second section.
    const one = usageTooltip(session, 0.5, api, { split: session, costUsd: 0.5, generation: 1 });
    expect(one).toContain("350 new tokens this task");
    expect(one).not.toContain("Lifetime");
    // After a /clear: the chip's figures are the current window, lifetime follows.
    const two = usageTooltip(session, 0.5, api, { split: usageSplit(real), costUsd: 4.7, generation: 2 });
    expect(two).toContain("350 new tokens this session (2 of 2)");
    expect(two).toContain("$0.500 billed");
    expect(two).toContain("Lifetime across 2 sessions");
    expect(two).toContain("253,000 new tokens");
    expect(two).toContain("3,753,000 tokens total");
    expect(two).toContain("$4.70 billed");
  });
});
