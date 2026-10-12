import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/tasks/route";
import { createProject, createTask, getTask, updateTask } from "@/lib/store";

const post = (body: unknown) => POST(new Request("http://localhost/api/tasks", {
  method: "POST", body: JSON.stringify(body),
}));

describe("task creation with run controls", () => {
  it("persists provider and model before the first turn without copying session state", async () => {
    const project = createProject({ name: "Compare" });
    const original = createTask({ project_id: project.id, title: "Implement search", description: "Search projects", priority: "hi", agent: "claude", send_context: false });
    updateTask(original.id, { started: 1, model: "opus", resolved_model: "claude-opus", worktree_path: "/tmp/original", work_branch: "original", status: "in_review" });
    const before = getTask(original.id);
    const res = await post({ project_id: project.id, title: original.title, description: original.description, priority: original.priority, send_context: false, agent: "codex", model: " gpt-compare ", reasoning: "high", permission_mode: "fullAccess" });
    expect(res.status).toBe(201);
    const clone = await res.json();
    expect(clone.id).not.toBe(original.id);
    expect(clone).toMatchObject({ title: original.title, description: original.description, priority: "hi", agent: "codex", model: "gpt-compare", reasoning: "high", permission_mode: "fullAccess", send_context: 0, started: 0, running: 0, status: "not_started", generation: 1, session_id: null, resolved_model: null, worktree_path: "", work_branch: "", chain_id: null });
    expect(getTask(original.id)).toEqual(before);
  });

  it("keeps provider defaults when no run controls are supplied", async () => {
    const project = createProject({ name: "Defaults" });
    const res = await post({ project_id: project.id, title: "Default task" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ model: null, reasoning: null, permission_mode: null });
  });

  it.each([{ agent: "unknown" }, { model: 123 }, { model: "bad\nmodel" }, { model: "x".repeat(2049) }, { reasoning: {} }, { permission_mode: true }])("rejects invalid controls %j", async (controls) => {
    const project = createProject({ name: "Invalid" });
    expect((await post({ project_id: project.id, title: "Invalid task", ...controls })).status).toBe(400);
  });
});
