import { describe, it, expect } from "vitest";
import { commonSuggestionTag, isOrderedGroup, parseSuggestionTitle, planChainDeps } from "@/app/orchestrator/suggestions";
import type { TaskRow } from "@/app/orchestrator/types";

// Pure presentation + chain-planning helpers behind the redesigned "Suggested
// by agents" tray (app/orchestrator/SuggestionGroup.tsx).

const row = (id: string, title = id, depends_on: string[] = []) => ({ id, title, depends_on } as unknown as TaskRow);

describe("parseSuggestionTitle", () => {
  it("lifts leading bracket prefixes into tags and a priority", () => {
    expect(parseSuggestionTitle("[AO][Med] Touch-friendly board drag")).toEqual({ text: "Touch-friendly board drag", tags: ["AO"], priority: "med" });
    expect(parseSuggestionTitle("[High] [SEP6] Fix it")).toEqual({ text: "Fix it", tags: ["SEP6"], priority: "hi" });
  });
  it("leaves mid-title brackets and plain titles alone", () => {
    expect(parseSuggestionTitle("Parse [AO] tags")).toEqual({ text: "Parse [AO] tags", tags: [], priority: null });
  });
  it("keeps the raw title when it is nothing but brackets", () => {
    expect(parseSuggestionTitle("[AO][Low]")).toEqual({ text: "[AO][Low]", tags: [], priority: null });
  });
});

describe("commonSuggestionTag / isOrderedGroup", () => {
  it("finds the tag every member shares", () => {
    expect(commonSuggestionTag([row("a", "[AO][Hi] A"), row("b", "[AO] [X] B")])).toBe("AO");
    expect(commonSuggestionTag([row("a", "[AO] A"), row("b", "B")])).toBeNull();
  });
  it("is ordered only when members depend on each other", () => {
    expect(isOrderedGroup([row("a"), row("b", "b", ["a"])])).toBe(true);
    expect(isOrderedGroup([row("a", "a", ["elsewhere"]), row("b")])).toBe(false);
  });
});

describe("planChainDeps", () => {
  it("links each selected task to the previous one, keeping outside edges", () => {
    const tasks = [row("a", "a", ["ext"]), row("b"), row("c")];
    const plan = planChainDeps(tasks, ["a", "b", "c"], ["a", "b", "c"], "done");
    expect(plan.clear).toEqual([]);
    expect(plan.link).toEqual([{ id: "b", depends_on: ["a"] }, { id: "c", depends_on: ["b"] }]);
  });

  it("clears reversed in-group edges before linking, so the cycle guard never trips", () => {
    // Agent proposed b → a (b depends on a); the user reordered to b, a.
    const tasks = [row("a"), row("b", "b", ["a"])];
    const plan = planChainDeps(tasks, ["a", "b"], ["b", "a"], "done");
    expect(plan.clear).toEqual([{ id: "b", depends_on: [] }]);
    expect(plan.link).toEqual([{ id: "a", depends_on: ["b"] }]);
  });

  it("drops edges onto excluded members, and 'now' leaves the chain unlinked", () => {
    const tasks = [row("a"), row("b", "b", ["x"]), row("x")];
    expect(planChainDeps(tasks, ["a", "b", "x"], ["a", "b"], "now")).toEqual({
      clear: [{ id: "b", depends_on: [] }],
      link: [],
    });
  });

  it("is a no-op when the agent's chain already matches the reviewed order", () => {
    const tasks = [row("a"), row("b", "b", ["a"])];
    expect(planChainDeps(tasks, ["a", "b"], ["a", "b"], "done")).toEqual({ clear: [], link: [] });
  });
});
