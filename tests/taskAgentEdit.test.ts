import { describe, expect, it } from "vitest";
import { PATCH as patchTask } from "@/app/api/tasks/[id]/route";
import { createProject, createTask, getTask, updateTask } from "@/lib/store";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function patch(id: string, body: Record<string, unknown>) {
  return patchTask(
    new Request("http://test", { method: "PATCH", body: JSON.stringify(body) }),
    params(id),
  );
}

describe("editing a task's agent", () => {
  it("accepts a Bedrock inference-profile ARN as a custom model", async () => {
    const project = createProject({ name: "Bedrock model" });
    const task = createTask({ project_id: project.id, title: "Use profile", agent: "claude" });
    const model = "arn:aws:bedrock:us-east-2:123456789012:application-inference-profile/sonnet-prod";
    const response = await patch(task.id, { model: `  ${model}  ` });
    expect(response.status).toBe(200);
    expect(getTask(task.id)?.model).toBe(model);
  });

  it.each([
    ["non-string", { model: { id: "opus" } }],
    ["control character", { model: "opus\nsonnet" }],
    ["oversized", { model: "m".repeat(2049) }],
  ])("rejects an invalid custom model: %s", async (_name, body) => {
    const project = createProject({ name: `Bad model ${_name}` });
    const task = createTask({ project_id: project.id, title: "Invalid model", agent: "claude" });
    const response = await patch(task.id, body);
    expect(response.status).toBe(400);
    expect(getTask(task.id)?.model).toBeNull();
  });

  it("switches an unstarted task and clears provider-specific run controls", async () => {
    const project = createProject({ name: "Agent switch" });
    const task = createTask({ project_id: project.id, title: "Switch me", agent: "claude" });
    updateTask(task.id, {
      model: "claude-opus-4-1",
      resolved_model: "claude-opus-4-1-20250805",
      reasoning: "deep",
      permission_mode: "bypassPermissions",
    });

    const response = await patch(task.id, { agent: "codex" });

    expect(response.status).toBe(200);
    expect(getTask(task.id)).toMatchObject({
      agent: "codex",
      model: null,
      resolved_model: null,
      reasoning: null,
      permission_mode: null,
      session_id: null,
    });
  });

  it("keeps run controls when the submitted agent is unchanged", async () => {
    const project = createProject({ name: "Same agent" });
    const task = createTask({ project_id: project.id, title: "Keep settings", agent: "claude" });
    updateTask(task.id, { model: "claude-sonnet-4-5", reasoning: "deep" });

    const response = await patch(task.id, { title: "Renamed", agent: "claude" });

    expect(response.status).toBe(200);
    expect(getTask(task.id)).toMatchObject({ title: "Renamed", agent: "claude", model: "claude-sonnet-4-5", reasoning: "deep" });
  });

  it.each([
    ["started", { started: 1 }],
    ["running", { running: 1 }],
  ])("rejects a switch after the task is %s", async (state, taskPatch) => {
    const project = createProject({ name: `Locked ${state}` });
    const task = createTask({ project_id: project.id, title: "Locked", agent: "claude" });
    updateTask(task.id, taskPatch);

    const response = await patch(task.id, { agent: "codex" });

    expect(response.status).toBe(409);
    expect(getTask(task.id)?.agent).toBe("claude");
  });

  it("rejects an unknown agent", async () => {
    const project = createProject({ name: "Bad agent" });
    const task = createTask({ project_id: project.id, title: "Invalid", agent: "claude" });

    const response = await patch(task.id, { agent: "not-registered" });

    expect(response.status).toBe(400);
    expect(getTask(task.id)?.agent).toBe("claude");
  });
});
