import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/tasks/accept-batch/route";
import { createProject, createTask, getTask, setTaskDeps, updateTask, listTasks } from "@/lib/store";
import { getDb } from "@/lib/db";
import { groupSuggestions } from "@/app/orchestrator/suggestions";

const post = (body: unknown) => POST(new Request("http://localhost/api/tasks/accept-batch", {
  method: "POST", body: JSON.stringify(body),
}));
function fixture() {
  const project = createProject({ name: "Batch" });
  const parent = createTask({ project_id: project.id, title: "Planner" });
  const make = (title: string, generation = 1) => createTask({ project_id: project.id, title,
    suggested: true, suggested_by_task_id: parent.id, suggested_by_generation: generation });
  const a = make("A"), b = make("B"), c = make("C", 2);
  setTaskDeps(b.id, [a.id]); setTaskDeps(c.id, [b.id]);
  return { project, a, b, c, make, ids: [a.id, b.id, c.id] };
}
describe("batch acceptance", () => {
  it("accepts all and arms only tasks with unfinished blockers", async () => {
    const { ids, a, b, c } = fixture();
    const response = await post({ ids, start_chain: true });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.root_ids).toEqual([a.id]);
    expect(result.tasks.map((t: { suggested: number }) => t.suggested)).toEqual([0, 0, 0]);
    expect(getTask(a.id)!.auto_start).toBe(0);
    expect(getTask(b.id)!.auto_start).toBe(1);
    expect(getTask(c.id)!.auto_start).toBe(1);
    expect(result.tasks[2].depends_on).toEqual([b.id]);
  });
  it("accept alone does not arm dependents", async () => {
    const { ids } = fixture();
    expect((await post({ ids })).status).toBe(200);
    expect(ids.map((id) => getTask(id)!.auto_start)).toEqual([0, 0, 0]);
  });
  it("rejects a stale or missing member without accepting any others", async () => {
    const { ids, a, c } = fixture();
    expect((await post({ ids: [...ids, "missing"] })).status).toBe(409);
    expect(getTask(a.id)!.suggested).toBe(1);
    updateTask(c.id, { suggested: 0 });
    expect((await post({ ids, start_chain: true })).status).toBe(409);
    expect(getTask(a.id)).toMatchObject({ suggested: 1, auto_start: 0 });
  });
  it("rolls back writes when a later update fails", async () => {
    const { ids } = fixture();
    getDb().exec(`CREATE TEMP TRIGGER fail_batch BEFORE UPDATE ON tasks WHEN OLD.title = 'B'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    try {
      expect((await post({ ids, start_chain: true })).status).toBe(409);
      expect(ids.map((id) => getTask(id)!.suggested)).toEqual([1, 1, 1]);
      expect(ids.map((id) => getTask(id)!.auto_start)).toEqual([0, 0, 0]);
    } finally { getDb().exec("DROP TRIGGER fail_batch"); }
  });
  it("requires confirmation for more than three roots before any writes", async () => {
    const { make } = fixture();
    const ids = [1, 2, 3, 4].map((i) => make(`Root ${i}`).id);
    const result = await (await post({ ids, start_chain: true })).json();
    expect(result.confirmation_required).toBe(true);
    expect(ids.every((id) => getTask(id)!.suggested)).toBe(true);
    expect((await (await post({ ids, start_chain: true, confirmed_roots: true })).json()).tasks).toHaveLength(4);
  });
  it("validates ids, projects and boolean options", async () => {
    const { a } = fixture();
    const other = createTask({ project_id: createProject({ name: "Other" }).id, title: "Other", suggested: true });
    for (const body of [{ ids: [] }, { ids: [a.id, a.id] }, { ids: [a.id], start_chain: 1 }])
      expect((await post(body)).status).toBe(400);
    expect((await post({ ids: [a.id, other.id] })).status).toBe(409);
    expect(getTask(a.id)!.suggested).toBe(1);
  });
  it("terminal blockers are roots; external unfinished blockers are armed", async () => {
    const { a, b, c } = fixture();
    updateTask(a.id, { status: "cancelled", suggested: 0 });
    const result = await (await post({ ids: [b.id, c.id], start_chain: true })).json();
    expect(result.root_ids).toEqual([b.id]);
    expect(getTask(c.id)!.auto_start).toBe(1);
  });
  it("merges connected generations, pulls in siblings and orders the whole filtered chain", () => {
    const { project, a, b, c, make } = fixture();
    const sibling = make("Sibling", 2);
    const all = listTasks(project.id);
    const groups = groupSuggestions(all.filter((t) => t.id === c.id), all);
    expect(groups).toHaveLength(1);
    const ids = groups[0].tasks.map((t) => t.id);
    expect(new Set(ids)).toEqual(new Set([a.id, b.id, c.id, sibling.id]));
    expect(ids.indexOf(a.id)).toBeLessThan(ids.indexOf(b.id));
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(c.id));
  });
});
