import { describe, it, expect } from "vitest";
import { parseSuggestionCard, suggestionBatches } from "@/app/orchestrator/suggestions";
import type { Msg } from "@/app/orchestrator/types";
import type { ToolData } from "@/lib/types";

// The transcript half of suggestions: which persisted tool rows are suggest_task
// cards, and which turns get a "Suggested this session" summary block.

const tool = (id: string, data: ToolData): Msg => ({ id, role: "tool", content: JSON.stringify(data), generation: 1 });
const msg = (id: string, role: Msg["role"], content = ""): Msg => ({ id, role, content, generation: 1 });
const sug = (id: string, title: string, taskId?: string) => tool(id, { title: "✦ Suggested a task", suggestion: { title, taskId } });

describe("parseSuggestionCard", () => {
  it("reads the suggestion payload off a tool row and nothing else", () => {
    expect(parseSuggestionCard(sug("m1", "Do X", "t1"))).toEqual({ title: "Do X", taskId: "t1" });
    // A plain tool row, a non-tool row, and a row that merely mentions the key in
    // its result text all read as "not a suggestion".
    expect(parseSuggestionCard(tool("m2", { title: "❯ ls", result: "ok" }))).toBeNull();
    expect(parseSuggestionCard(msg("m3", "assistant", '{"suggestion": true}'))).toBeNull();
    expect(parseSuggestionCard(tool("m4", { title: "📖 Read", result: 'grep "suggestion"' }))).toBeNull();
    expect(parseSuggestionCard(msg("m5", "tool", "not json {\"suggestion\""))).toBeNull();
  });
});

describe("suggestionBatches", () => {
  it("summarizes a turn that filed two or more suggestions, after its last message", () => {
    const messages = [
      msg("u1", "user", "plan it"),
      msg("a1", "assistant", "Here's the plan."),
      sug("s1", "One", "t1"),
      tool("x1", { title: "❯ git status", result: "" }),
      sug("s2", "Two", "t2"),
      sug("s3", "Three", "t3"),
      msg("a2", "assistant", "Filed three."),
    ];
    const batches = suggestionBatches(messages);
    expect([...batches.keys()]).toEqual(["a2"]);
    expect(batches.get("a2")!.map((c) => c.suggestion.title)).toEqual(["One", "Two", "Three"]);
    expect(batches.get("a2")![0]).toEqual({ msgId: "s1", suggestion: { title: "One", taskId: "t1" }, ts: undefined });
  });

  it("gives every turn its own batch and skips turns with fewer than two", () => {
    const messages = [
      msg("u1", "user"),
      sug("s1", "Lonely", "t1"), // one suggestion — the inline chip is enough
      msg("u2", "user"),
      sug("s2", "A", "t2"),
      sug("s3", "B", "t3"), // the block follows the turn's LAST message — this one
      msg("u3", "user"),
      sug("s4", "C", "t4"),
      msg("a3", "assistant"),
      sug("s5", "D", "t5"),
      msg("a4", "assistant", "done"),
    ];
    const batches = suggestionBatches(messages);
    expect([...batches.keys()]).toEqual(["s3", "a4"]);
    expect(batches.get("s3")!.map((c) => c.suggestion.title)).toEqual(["A", "B"]);
    expect(batches.get("a4")!.map((c) => c.suggestion.title)).toEqual(["C", "D"]);
  });

  it("treats a /clear session break and a queued follow-up as turn boundaries", () => {
    const messages = [
      msg("u1", "user"),
      sug("s1", "A", "t1"),
      msg("sb", "session_break", "summary"),
      sug("s2", "B", "t2"),
      sug("s3", "C", "t3"),
      msg("q1", "queued", "later"),
    ];
    const batches = suggestionBatches(messages);
    // A alone before the break: no block. B + C after it: one block on C — never
    // on the break or the queued bubble themselves.
    expect([...batches.keys()]).toEqual(["s3"]);
  });

  it("ignores suggest cards whose call failed (no task id) for the count but still lists them", () => {
    // A failed call (project deleted mid-turn) keeps its card as a plain tool
    // line in the transcript; the batch lists what the turn *proposed*.
    const messages = [msg("u1", "user"), sug("s1", "A"), sug("s2", "B", "t2")];
    expect(suggestionBatches(messages).get("s2")!.map((c) => c.suggestion.taskId)).toEqual([undefined, "t2"]);
  });
});
