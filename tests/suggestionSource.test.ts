import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { createProject, createTask, getTask, listTasks, updateTask, deleteTask } from "@/lib/store";
import { createSuggestedTask } from "@/lib/agentTools";
import { POST as suggestTask } from "@/app/api/internal/agent-tools/suggest-task/route";
import { groupSuggestions, showsGroupHeaders, suggestionGroupLabel } from "@/app/orchestrator/suggestions";
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
});

// --- tray grouping (pure, so it's unit-testable without the DOM) ---

let n = 0;
function row(over: Partial<TaskRow> & { id?: string }): TaskRow {
  const id = over.id ?? `t${++n}`;
  return {
    id, project_id: "p", title: id, description: "", priority: "med", status: "not_started", suggested: 1,
    agent: "claude", send_context: 1, model: null, resolved_model: null, reasoning: null, permission_mode: null,
    session_id: null, worktree_path: "", pr_url: "", generation: 1, started: 0, running: 0, awaiting_input: 0,
    updated_at: 0, cost_usd: 0, total_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, depends_on: [],
    auto_start: 0, suggested_by_task_id: null, suggested_by_generation: null, context_tokens: 0, context_pct: 0,
    ...over,
  };
}

describe("groupSuggestions", () => {
  it("groups by (parent, generation), keeps batch order, and trails Other", () => {
    const parentA = row({ id: "A", title: "Auth work", suggested: 0 });
    const parentB = row({ id: "B", title: "Docs pass", suggested: 0 });
    const suggested = [
      row({ id: "s1", suggested_by_task_id: "A", suggested_by_generation: 1 }),
      row({ id: "s2", suggested_by_task_id: "B", suggested_by_generation: 2 }),
      row({ id: "s3", suggested_by_task_id: "A", suggested_by_generation: 1 }),
      row({ id: "s4" }), // pre-migration row: no proposer
      // Same parent, a later /clear generation — a separate group on purpose.
      row({ id: "s5", suggested_by_task_id: "A", suggested_by_generation: 2 }),
    ];
    const groups = groupSuggestions(suggested, [parentA, parentB, ...suggested]);
    expect(groups.map((g) => g.tasks.map((t) => t.id))).toEqual([["s1", "s3"], ["s2"], ["s5"], ["s4"]]);
    expect(groups.map((g) => suggestionGroupLabel(g))).toEqual([
      "From: Auth work · session 1",
      "From: Docs pass · session 2",
      "From: Auth work · session 2",
      "Other",
    ]);
    expect(showsGroupHeaders(groups)).toBe(true);
  });

  it("falls back to a single unheadered bucket when nothing has a known proposer", () => {
    // A dangling id (parent deleted before the FK existed / filtered out) is
    // treated exactly like no id at all.
    const suggested = [row({ id: "s1" }), row({ id: "s2", suggested_by_task_id: "ghost", suggested_by_generation: 1 })];
    const groups = groupSuggestions(suggested, suggested);
    expect(groups).toHaveLength(1);
    expect(groups[0].parent).toBeNull();
    expect(groups[0].tasks.map((t) => t.id)).toEqual(["s1", "s2"]);
    expect(showsGroupHeaders(groups)).toBe(false);
  });
});
