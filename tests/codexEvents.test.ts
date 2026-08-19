import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import { mapThreadEvent, newState } from "@/lib/agents/codex/events";
import { estimateCostUsd, resolveCodexModel, DEFAULT_CODEX_MODEL } from "@/lib/agents/codex/pricing";
import { CODEX_CAPABILITIES } from "@/lib/agents/codex/capabilities";
import type { StreamEvent } from "@/lib/types";

// The Codex event-mapping unit test. Feeds recorded codex `codex exec
// --experimental-json` JSONL (two fixtures captured from real turns, one
// synthetic fixture covering the item types those runs didn't emit) through the
// normalizer and asserts the resulting StreamEvent stream. This is the seam's
// contract for Codex: the same StreamEvents the runner persists for any driver.

function runFixture(name: string): StreamEvent[] {
  const file = path.join(__dirname, "fixtures", "codex", name);
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  const state = newState();
  const out: StreamEvent[] = [];
  for (const line of lines) {
    const ev = JSON.parse(line) as ThreadEvent;
    out.push(...mapThreadEvent(ev, state));
  }
  return out;
}

const byType = (evs: StreamEvent[], t: StreamEvent["type"]) => evs.filter((e) => e.type === t);

describe("codex event mapping", () => {
  it("maps a command + file_change + message + usage turn", () => {
    const evs = runFixture("command-file-message.jsonl");

    // thread.started → a single session event with the opaque thread id.
    const sessions = byType(evs, "session");
    expect(sessions).toHaveLength(1);
    expect((sessions[0] as Extract<StreamEvent, { type: "session" }>).sessionId).toBe("019f3ecf-fed2-7ba3-b46e-dc6097412033");

    // Two agent_message items → two assistant events, in order.
    const assistants = byType(evs, "assistant") as Extract<StreamEvent, { type: "assistant" }>[];
    expect(assistants.map((a) => a.content)).toEqual([
      "I ran `echo hi`. Now I’m creating `notes.txt` with the requested content.",
      "DONE",
    ]);

    // The command emits a tool (❯ title) + a tool_result carrying its output.
    const tools = byType(evs, "tool") as Extract<StreamEvent, { type: "tool" }>[];
    const cmd = tools.find((t) => t.id === "item_0")!;
    expect(cmd.title).toBe("❯ /bin/zsh -lc 'echo hi'");
    const results = byType(evs, "tool_result") as Extract<StreamEvent, { type: "tool_result" }>[];
    const cmdResult = results.find((r) => r.id === "item_0")!;
    expect(cmdResult.isError).toBe(false);
    expect(cmdResult.content).toBe("hi\n");
    expect(cmdResult.peek).toMatchObject({ kind: "lines" });

    // The file_change emits a single tool with a git-status-style lines peek,
    // and (since it succeeded) no tool_result.
    const fc = tools.find((t) => t.id === "item_2")!;
    expect(fc.title).toBe("✎ Create notes.txt");
    expect(fc.peek).toMatchObject({ kind: "lines", lines: ["A  /work/notes.txt"] });
    expect(results.find((r) => r.id === "item_2")).toBeUndefined();

    // turn.completed → one usage event. Codex's input_tokens (39612) is the FULL
    // prompt including the 30848 cached reads; the buckets are kept disjoint, so
    // input_tokens carries fresh prompt only and the total doesn't double-count
    // the cache. Reasoning folds into output. cost_usd is ESTIMATED from the
    // token counts at the default model's published API prices
    // (8764×$5.00 + 30848×$0.50 + 119×$30, per 1M).
    const usage = byType(evs, "usage") as Extract<StreamEvent, { type: "usage" }>[];
    expect(usage).toHaveLength(1);
    expect(usage[0].usage).toMatchObject({
      input_tokens: 8764,
      output_tokens: 119,
      cache_read_tokens: 30848,
      cache_creation_tokens: 0,
    });
    expect(usage[0].usage.cost_usd).toBeCloseTo(0.062814, 6);

    // No EMPTY sentinel leaks through, and every tool id is emitted at most once.
    expect(evs.some((e) => e.type === "notice")).toBe(false);
    const toolIds = tools.map((t) => t.id);
    expect(new Set(toolIds).size).toBe(toolIds.length);
  });

  it("emits the running plan as one tool, refreshed in place via tool_result", () => {
    const evs = runFixture("todo-plan.jsonl");

    // The todo_list item (item_1) updates 5×, but only ONE tool message is
    // created; every later update is a tool_result refreshing the same row.
    const planTools = (byType(evs, "tool") as Extract<StreamEvent, { type: "tool" }>[]).filter((t) => t.id === "item_1");
    expect(planTools).toHaveLength(1);
    expect(planTools[0].title).toBe("☑ Plan");
    expect(planTools[0].peek).toMatchObject({
      kind: "todos",
      items: [
        { text: "Inspect app.py", status: "pending" },
        { text: "Add docstring and second print", status: "pending" },
        { text: "Verify result", status: "pending" },
      ],
    });

    const planResults = (byType(evs, "tool_result") as Extract<StreamEvent, { type: "tool_result" }>[]).filter((r) => r.id === "item_1");
    expect(planResults.length).toBeGreaterThan(0);
    // The final refresh shows every item completed.
    const last = planResults[planResults.length - 1];
    expect(last.peek).toMatchObject({ kind: "todos", items: [
      { text: "Inspect app.py", status: "completed" },
      { text: "Add docstring and second print", status: "completed" },
      { text: "Verify result", status: "completed" },
    ] });

    // Commands still pair tool + tool_result; every tool id is unique.
    const tools = byType(evs, "tool") as Extract<StreamEvent, { type: "tool" }>[];
    const ids = tools.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(tools.some((t) => t.title.startsWith("❯ "))).toBe(true);
  });

  it("maps reasoning, web search, mcp tool calls, item errors, and turn failure", () => {
    const evs = runFixture("reasoning-mcp-search.jsonl");
    const tools = byType(evs, "tool") as Extract<StreamEvent, { type: "tool" }>[];
    const results = byType(evs, "tool_result") as Extract<StreamEvent, { type: "tool_result" }>[];

    // reasoning → a collapsed "🧠 Thinking" tool line (no result).
    const think = tools.find((t) => t.id === "item_r0")!;
    expect(think.title).toBe("🧠 Thinking");
    expect(think.peek).toMatchObject({ kind: "lines" });

    // web_search → a single tool line, emitted once (started + completed = 1).
    const search = tools.filter((t) => t.id === "item_w0");
    expect(search).toHaveLength(1);
    expect(search[0].title).toBe("🔎 Web search: codex sdk thread events");

    // A successful mcp tool call → tool + tool_result with the flattened text.
    expect(tools.find((t) => t.id === "item_m0")!.title).toBe("⚙ docs: lookup");
    const ok = results.find((r) => r.id === "item_m0")!;
    expect(ok.isError).toBe(false);
    expect(ok.content).toBe("A thread has many turns.");

    // A failed mcp tool call → tool_result with the error message + isError.
    const bad = results.find((r) => r.id === "item_m1")!;
    expect(bad.isError).toBe(true);
    expect(bad.content).toBe("tool exploded");

    // Item-level and turn-level failures both surface as error events.
    const errors = (byType(evs, "error") as Extract<StreamEvent, { type: "error" }>[]).map((e) => e.content);
    expect(errors).toContain("a non-fatal item error");
    expect(errors).toContain("the model turn failed");

    // The final agent message still comes through as an assistant event.
    expect((byType(evs, "assistant")[0] as Extract<StreamEvent, { type: "assistant" }>).content).toBe("All done.");
  });
});

describe("codex cost estimation", () => {
  // The app's DISJOINT bucket form (what events.ts emits): 600k fresh prompt
  // tokens alongside 400k cache reads, i.e. a 1M-token prompt.
  const usage = { input_tokens: 600_000, output_tokens: 100_000, cache_read_tokens: 400_000, cache_creation_tokens: 0 };

  it("prices per resolved model: fresh + cached input and output at published rates", () => {
    // Max: 600k×$1.25 + 400k×$0.125 + 100k×$10 per 1M = 0.75 + 0.05 + 1.00.
    expect(estimateCostUsd("gpt-5.1-codex-max", usage)).toBeCloseTo(1.8, 10);
    // Mini: 600k×$0.25 + 400k×$0.025 + 100k×$2 per 1M = 0.15 + 0.01 + 0.20.
    expect(estimateCostUsd("gpt-5.1-codex-mini", usage)).toBeCloseTo(0.36, 10);
  });

  it("prefix-matches dated ids and falls back to the default family for unknown models", () => {
    expect(estimateCostUsd("gpt-5.1-codex-mini-2026-01-15", usage)).toBeCloseTo(0.36, 10);
    expect(estimateCostUsd("some-future-model", usage)).toBeCloseTo(estimateCostUsd(DEFAULT_CODEX_MODEL, usage), 10);
  });

  it("prices each 5.6 tier distinctly — the bare alias follows Sol, not the catch-all", () => {
    // Sol $5/$0.50/$30, Terra $2/$0.20/$12, Luna $0.20/$0.02/$1.20 per 1M
    // (developers.openai.com/api/docs/pricing). Ordering matters: "gpt-5.6" is a
    // prefix of all three, so it must be matched last or it swallows them.
    expect(estimateCostUsd("gpt-5.6-sol", usage)).toBeCloseTo(6.2, 10); // 3.0 + 0.2 + 3.0
    expect(estimateCostUsd("gpt-5.6-terra", usage)).toBeCloseTo(2.48, 10); // 1.2 + 0.08 + 1.2
    expect(estimateCostUsd("gpt-5.6-luna", usage)).toBeCloseTo(0.248, 10); // 0.12 + 0.008 + 0.12
    expect(estimateCostUsd("gpt-5.6", usage)).toBeCloseTo(estimateCostUsd("gpt-5.6-sol", usage), 10);
  });

  it("has a real price row for every model the picker offers", () => {
    // Guards the drift that makes an estimate silently wrong: a new picker entry
    // with no row of its own falls through to the bare "gpt-5" catch-all and
    // quietly prices at the wrong rate instead of failing.
    const catchAll = estimateCostUsd("gpt-5-nonexistent-family", usage);
    for (const m of CODEX_CAPABILITIES.models) {
      expect(estimateCostUsd(m.value, usage), m.value).not.toBeCloseTo(catchAll, 10);
    }
  });

  it("bills cache writes at the plain input rate and never bills a negative bucket", () => {
    // Cache writes are ordinary input tokens (OpenAI adds no write surcharge).
    const w = estimateCostUsd("gpt-5.1-codex-max", { input_tokens: 100, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 100 });
    expect(w).toBeCloseTo((200 * 1.25) / 1e6, 12);
    // A bucket that somehow arrives negative contributes nothing rather than
    // refunding the turn.
    const n = estimateCostUsd("gpt-5.1-codex-max", { input_tokens: -500, output_tokens: 0, cache_read_tokens: 100, cache_creation_tokens: 0 });
    expect(n).toBeCloseTo((100 * 0.125) / 1e6, 12);
  });

  it("resolves the task's model, else the CLI default", () => {
    expect(resolveCodexModel("gpt-5.1-codex-mini")).toBe("gpt-5.1-codex-mini");
    expect(resolveCodexModel(null)).toBe(DEFAULT_CODEX_MODEL);
  });

  it("threads the state's model into the turn.completed estimate", () => {
    const ev = {
      type: "turn.completed",
      usage: { input_tokens: 1_000_000, cached_input_tokens: 400_000, output_tokens: 60_000, reasoning_output_tokens: 40_000 },
    } as unknown as ThreadEvent;
    const [out] = mapThreadEvent(ev, newState("gpt-5.1-codex-mini"));
    if (out.type !== "usage") throw new Error("expected usage event");
    // Reasoning folds into output before pricing: 100k output at mini rates.
    expect(out.usage.output_tokens).toBe(100_000);
    expect(out.usage.cost_usd).toBeCloseTo(0.36, 10);
  });
});

// Codex reports the THREAD's running totals on every turn.completed, so without
// a baseline every turn re-bills the whole conversation (a 5-turn task ends up
// charging turn 1 five times, and the per-turn figure the UI appends at turn end
// is meaningless). The usage event must carry THIS turn's delta.
describe("codex cumulative usage → per-turn deltas", () => {
  const completed = (input: number, cached: number, output: number, reasoning = 0, cacheWrite = 0) =>
    ({
      type: "turn.completed",
      usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        cache_write_input_tokens: cacheWrite,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
      },
    }) as unknown as ThreadEvent;

  function usageOf(ev: ThreadEvent, state: ReturnType<typeof newState>) {
    const [out] = mapThreadEvent(ev, state);
    if (out.type !== "usage") throw new Error("expected usage event");
    return out.usage;
  }

  it("charges only the growth since the thread's last reported total", () => {
    const state = newState("gpt-5.1-codex-max");
    // Turn 1 on a fresh thread: nothing to subtract.
    const first = usageOf(completed(14_000, 11_000, 500), state);
    expect(first).toMatchObject({ input_tokens: 3_000, cache_read_tokens: 11_000, output_tokens: 500 });
    // Turn 2 re-reports the thread's totals; only the delta is this turn's.
    const second = usageOf(completed(28_000, 22_000, 900), state);
    expect(second).toMatchObject({ input_tokens: 3_000, cache_read_tokens: 11_000, output_tokens: 400 });
    // The state carries the raw cumulative forward for the driver to persist.
    expect(state.cum).toMatchObject({ input: 28_000, cachedInput: 22_000, output: 900 });
    expect(state.cumDirty).toBe(true);
  });

  it("resumes from the baseline a previous turn left behind (new process, same thread)", () => {
    // What the driver does on resume: seed the state from sessions.usage_cum.
    const state = newState("gpt-5.1-codex-max", { input: 28_000, cachedInput: 22_000, cacheWrite: 0, output: 900, reasoning: 0 });
    const u = usageOf(completed(30_000, 23_000, 1_100, 200), state);
    expect(u).toMatchObject({ input_tokens: 1_000, cache_read_tokens: 1_000, output_tokens: 400 });
  });

  it("takes a non-cumulative report at face value instead of zeroing the turn", () => {
    // Counters going backwards mean the thread reset (or upstream switched to
    // per-turn reporting) — subtracting would swallow the turn entirely.
    const state = newState("gpt-5.1-codex-max", { input: 99_000, cachedInput: 0, cacheWrite: 0, output: 9_000, reasoning: 0 });
    const u = usageOf(completed(5_000, 1_000, 300), state);
    expect(u).toMatchObject({ input_tokens: 4_000, cache_read_tokens: 1_000, output_tokens: 300 });
    expect(state.cum.input).toBe(5_000);
  });

  it("keeps the three token buckets disjoint (cache reads/writes netted out of input)", () => {
    const state = newState("gpt-5.1-codex-max");
    const u = usageOf(completed(10_000, 6_000, 100, 0, 1_500), state);
    expect(u).toMatchObject({ input_tokens: 2_500, cache_read_tokens: 6_000, cache_creation_tokens: 1_500 });
    // 2_500 + 6_000 + 1_500 = the 10_000-token prompt, counted exactly once.
    expect(u.input_tokens + u.cache_read_tokens + u.cache_creation_tokens).toBe(10_000);
  });
});
