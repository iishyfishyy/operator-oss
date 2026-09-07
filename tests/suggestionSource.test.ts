import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { createProject, createTask, getTask, listTasks, updateTask, deleteTask } from "@/lib/store";
import { createSuggestedTask } from "@/lib/agentTools";
import { POST as suggestTask } from "@/app/api/internal/agent-tools/suggest-task/route";
import {
  STALE_AFTER_MS, countNewSuggestions, groupSuggestions, isNewSuggestion, suggestionGroupLabel,
} from "@/app/orchestrator/suggestions";
import type { TaskRow } from "@/app/orchestrator/types";

// Suggestion provenance: which task (and which /clear generation of it) called
// suggest_task. The tray groups by it, so it has to survive the write path from
// both callers — the in-process Claude MCP server and the stdio bridge's HTTP
// endpoint — and degrade to "no parent" rather than failing.

function post(url: string, body: unknown) {
  return suggestTask(
    new NextRequest(`http://127.0.0.1:3000${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("suggestion provenance columns", () => {
  it("createTask persists and listTasks exposes suggested_by_task_id / _generation", () => {
    const project = createProject({ name: "Prov" });
    const parent = createTask({ project_id: project.id, title: "Parent" });
    const child = createTask({
      project_id: project.id,
      title: "Child",
      suggested: true,
      suggested_by_task_id: parent.id,
      suggested_by_generation: 3,
    });
    expect(getTask(child.id)).toMatchObject({ suggested_by_task_id: parent.id, suggested_by_generation: 3 });

    const listed = listTasks(project.id).find((t) => t.id === child.id)!;
    expect(listed.suggested_by_task_id).toBe(parent.id);
    expect(listed.suggested_by_generation).toBe(3);

    // A plain user-created task has no provenance at all.
    expect(getTask(parent.id)).toMatchObject({ suggested_by_task_id: null, suggested_by_generation: null });
  });

  it("keeps provenance across unrelated task edits", () => {
    const project = createProject({ name: "Prov-Edit" });
    const parent = createTask({ project_id: project.id, title: "Parent" });
    const child = createTask({ project_id: project.id, title: "Child", suggested: true, suggested_by_task_id: parent.id, suggested_by_generation: 2 });
    updateTask(child.id, { title: "Renamed", suggested: 0, status: "in_progress" });
    expect(getTask(child.id)).toMatchObject({ title: "Renamed", suggested_by_task_id: parent.id, suggested_by_generation: 2 });
  });

  it("clears the pointer when the proposing task is deleted (suggestion survives)", () => {
    const project = createProject({ name: "Prov-Del" });
    const parent = createTask({ project_id: project.id, title: "Doomed" });
    const child = createSuggestedTask(project, { title: "Orphan", description: "" }, { taskId: parent.id, generation: 1 }).task!;
    expect(getTask(child.id)!.suggested_by_task_id).toBe(parent.id);
    deleteTask(parent.id);
    const after = getTask(child.id)!;
    expect(after.title).toBe("Orphan");
    expect(after.suggested_by_task_id).toBeNull();
  });
});

describe("createSuggestedTask source", () => {
  it("stamps the proposing task + generation (the Claude driver's path)", () => {
    const project = createProject({ name: "Src" });
    const parent = createTask({ project_id: project.id, title: "Planner" });
    updateTask(parent.id, { generation: 4 });
    const { task } = createSuggestedTask(project, { title: "Follow-up", description: "later" }, { taskId: parent.id, generation: 4 });
    expect(getTask(task!.id)).toMatchObject({ suggested_by_task_id: parent.id, suggested_by_generation: 4, suggested: 1 });
  });

  it("drops provenance (rather than throwing on the FK) when the proposer is gone", () => {
    const project = createProject({ name: "Src-Ghost" });
    const { task, text } = createSuggestedTask(project, { title: "Still lands", description: "" }, { taskId: "vanished", generation: 2 });
    expect(task).toBeTruthy();
    expect(text).toContain("Still lands");
    expect(getTask(task!.id)).toMatchObject({ suggested_by_task_id: null, suggested_by_generation: null });
  });

  it("records nothing when no source is given", () => {
    const project = createProject({ name: "Src-None" });
    const { task } = createSuggestedTask(project, { title: "Anonymous", description: "" });
    expect(getTask(task!.id)!.suggested_by_task_id).toBeNull();
  });
});

describe("suggest-task bridge endpoint", () => {
  it("stamps the posted taskId and its CURRENT generation", async () => {
    const project = createProject({ name: "Bridge" });
    const parent = createTask({ project_id: project.id, title: "Codex task" });
    updateTask(parent.id, { generation: 2 });
    const res = await post("/api/internal/agent-tools/suggest-task", {
      projectId: project.id,
      taskId: parent.id,
      title: "From the bridge",
      description: "",
    });
    const { id } = (await res.json()) as { id: string };
    expect(getTask(id)).toMatchObject({ suggested_by_task_id: parent.id, suggested_by_generation: 2 });
  });

  it("still creates the task when taskId is missing or unknown", async () => {
    const project = createProject({ name: "Bridge-NoTask" });
    for (const body of [{ title: "No task id" }, { taskId: "nope", title: "Unknown task id" }]) {
      const res = await post("/api/internal/agent-tools/suggest-task", { projectId: project.id, description: "", ...body });
      expect(res.status).toBe(200);
      const { id } = (await res.json()) as { id: string };
      expect(getTask(id)!.suggested_by_task_id).toBeNull();
    }
  });

  it("leaves a suggestion's generation behind when its proposer is deleted", () => {
    // The tray's "From a deleted task" bucket rests on this: suggested_by_task_id
    // is a FOREIGN KEY with ON DELETE SET NULL, but suggested_by_generation has
    // no FK — so a null id next to a non-null generation is durable evidence the
    // proposer was hard-deleted, not a row that never recorded one.
    const project = createProject({ name: "Orphaned" });
    const parent = createTask({ project_id: project.id, title: "Proposer" });
    const { task } = createSuggestedTask(project, { title: "Left behind", description: "" }, { taskId: parent.id, generation: 3 });
    expect(getTask(task!.id)).toMatchObject({ suggested_by_task_id: parent.id, suggested_by_generation: 3 });
    deleteTask(parent.id);
    expect(getTask(task!.id)).toMatchObject({ suggested_by_task_id: null, suggested_by_generation: 3 });
  });
});

// --- tray grouping (pure, so it's unit-testable without the DOM) ---


let n = 0;
function row(over: Partial<TaskRow> & { id?: string }): TaskRow {
  const id = over.id ?? `t${++n}`;
  return {
    id, project_id: "p", title: id, description: "", priority: "med", status: "not_started", suggested: 1,
    agent: "claude", send_context: 1, model: null, resolved_model: null, reasoning: null, permission_mode: null,
    session_id: null, worktree_path: "", pr_url: "", generation: 1, started: 0, running: 0, awaiting_input: 0,
    created_at: 0, updated_at: 0, cost_usd: 0, total_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
    session_cost_usd: 0, session_tokens: 0, session_cache_read_tokens: 0, session_cache_creation_tokens: 0,
    depends_on: [],
    auto_start: 0, suggested_by_task_id: null, suggested_by_generation: null, context_tokens: 0, context_pct: 0,
    ...over,
  };
}

const NOW = 1_800_000_000_000;
const ago = (ms: number) => NOW - ms;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("groupSuggestions", () => {
  it("groups by (parent, generation), keeps batch order, and trails the unattributed buckets", () => {
    const parentA = row({ id: "A", title: "Auth work", suggested: 0 });
    const parentB = row({ id: "B", title: "Docs pass", suggested: 0 });
    const suggested = [
      row({ id: "s1", suggested_by_task_id: "A", suggested_by_generation: 1, created_at: ago(3 * HOUR) }),
      row({ id: "s2", suggested_by_task_id: "B", suggested_by_generation: 2, created_at: ago(1 * HOUR) }),
      row({ id: "s3", suggested_by_task_id: "A", suggested_by_generation: 1, created_at: ago(2 * HOUR) }),
      row({ id: "s4", created_at: ago(30 * 60_000) }), // pre-provenance row: no proposer
      // Same parent, a later /clear generation — a separate group on purpose.
      row({ id: "s5", suggested_by_task_id: "A", suggested_by_generation: 2, created_at: ago(4 * HOUR) }),
    ];
    const groups = groupSuggestions(suggested, [parentA, parentB, ...suggested], NOW);
    // Newest group first (B at 1h, then A/gen1 at 2h, then A/gen2 at 4h), with
    // "Other" trailing however recent it is; members keep their input order.
    expect(groups.map((g) => g.tasks.map((t) => t.id))).toEqual([["s2"], ["s1", "s3"], ["s5"], ["s4"]]);
    expect(groups.map((g) => suggestionGroupLabel(g))).toEqual([
      "From: Docs pass · session 2",
      "From: Auth work · session 1",
      "From: Auth work · session 2",
      "Other",
    ]);
    expect(groups.map((g) => g.newestAt)).toEqual([ago(HOUR), ago(2 * HOUR), ago(4 * HOUR), ago(30 * 60_000)]);
    expect(groups.every((g) => !g.stale)).toBe(true);
  });

  it("separates suggestions whose proposer was deleted from ones that never recorded a proposer", () => {
    const suggested = [
      row({ id: "s1", created_at: ago(HOUR) }),
      // The shape a real delete leaves behind: the FK nulls the id, the
      // generation (no FK) survives. A dangling id reads the same way.
      row({ id: "s2", suggested_by_task_id: null, suggested_by_generation: 1, created_at: ago(HOUR) }),
    ];
    const groups = groupSuggestions(suggested, suggested, NOW);
    expect(groups.map((g) => [g.kind, g.tasks.map((t) => t.id)])).toEqual([
      ["gone", ["s2"]],
      ["other", ["s1"]],
    ]);
    expect(groups.map((g) => suggestionGroupLabel(g))).toEqual(["From a deleted task", "Other"]);
    // A dangling proposer id is positive evidence the proposer is gone; a row
    // that never had one is just old data, and says nothing about staleness.
    expect(groups.map((g) => g.stale)).toEqual([true, false]);
  });
});

describe("suggestion staleness", () => {
  const parent = (over: Partial<TaskRow>) => row({ id: "A", title: "Auth work", suggested: 0, ...over });
  const child = (created: number) => row({ id: "s1", suggested_by_task_id: "A", suggested_by_generation: 1, created_at: created });
  const only = (p: TaskRow, c: TaskRow) => groupSuggestions([c], [p, c], NOW)[0];

  it("is fresh while the proposer is live and the group is recent", () => {
    const g = only(parent({ status: "in_progress" }), child(ago(2 * DAY)));
    expect(g.stale).toBe(false);
    expect(g.staleReason).toBe("");
  });

  it("goes stale once the proposer reaches a terminal state, however recent the suggestion", () => {
    // Merging a task marks it done, so "merged" is covered by the done check.
    expect(only(parent({ status: "done" }), child(NOW)).staleReason).toBe("“Auth work” is done");
    expect(only(parent({ status: "cancelled" }), child(NOW)).staleReason).toBe("“Auth work” was cancelled");
  });

  it("goes stale on age alone, measured from the NEWEST member", () => {
    expect(only(parent({}), child(ago(STALE_AFTER_MS + 1))).staleReason).toBe("suggested over a week ago");
    expect(only(parent({}), child(ago(STALE_AFTER_MS - HOUR))).stale).toBe(false);

    // One recent addition keeps the whole group alive — it's a live proposer
    // still filling the tray, not a pile nobody has touched in a week.
    const p = parent({});
    const old = row({ id: "s1", suggested_by_task_id: "A", suggested_by_generation: 1, created_at: ago(30 * DAY) });
    const fresh = row({ id: "s2", suggested_by_task_id: "A", suggested_by_generation: 1, created_at: ago(HOUR) });
    const g = groupSuggestions([old, fresh], [p, old, fresh], NOW)[0];
    expect([g.oldestAt, g.newestAt]).toEqual([ago(30 * DAY), ago(HOUR)]);
    expect(g.stale).toBe(false);
  });
});

describe("new-since marking", () => {
  it("counts only suggestions created strictly after the mark", () => {
    const before = row({ id: "s1", created_at: ago(2 * HOUR) });
    const at = row({ id: "s2", created_at: ago(HOUR) });
    const after = row({ id: "s3", created_at: ago(HOUR) + 1 });
    const since = ago(HOUR);
    expect([before, at, after].map((t) => isNewSuggestion(t, since))).toEqual([false, false, true]);
    expect(countNewSuggestions([before, at, after], since)).toBe(1);
  });

  it("treats a never-seen tray as all-new and a not-yet-hydrated one as nothing-new", () => {
    const tray = [row({ id: "s1", created_at: ago(HOUR) }), row({ id: "s2", created_at: ago(9 * DAY) })];
    expect(countNewSuggestions(tray, 0)).toBe(2);
    // The sentinel useTrayView uses before prefs hydrate — it must never claim
    // a suggestion is new on the strength of a mark it hasn't read yet.
    expect(countNewSuggestions(tray, Number.POSITIVE_INFINITY)).toBe(0);
  });
});
