import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import { mapThreadEvent, newState } from "@/lib/agents/codex/events";
import { estimateCostUsd, resolveCodexModel, DEFAULT_CODEX_MODEL } from "@/lib/agents/codex/pricing";
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

    // turn.completed → one usage event: tokens from usage, reasoning folded
    // into output, cache_read from cached_input_tokens, and cost_usd ESTIMATED
    // from the token counts at the default model's published API prices
    // ((39612−30848)×$1.25 + 30848×$0.125 + 119×$10, per 1M).
    const usage = byType(evs, "usage") as Extract<StreamEvent, { type: "usage" }>[];
    expect(usage).toHaveLength(1);
    expect(usage[0].usage).toMatchObject({
      input_tokens: 39612,
      output_tokens: 119,
      cache_read_tokens: 30848,
      cache_creation_tokens: 0,
    });
    expect(usage[0].usage.cost_usd).toBeCloseTo(0.016001, 6);

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
  const usage = { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 400_000 };

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

  it("never bills cached reads above the full prompt (defensive clamp)", () => {
    // cache_read > input would go negative on fresh tokens without the clamp.
    const c = estimateCostUsd("gpt-5.1-codex-max", { input_tokens: 100, output_tokens: 0, cache_read_tokens: 200 });
    expect(c).toBeCloseTo((100 * 0.125) / 1e6, 12);
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
