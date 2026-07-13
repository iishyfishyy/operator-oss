import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { createProject, getTask, getTaskDeps } from "@/lib/store";
import { createSuggestedTask, registerExposedService, resolveTitleRefs } from "@/lib/agentTools";
import { POST as suggestTask } from "@/app/api/internal/agent-tools/suggest-task/route";
import { POST as exposeService } from "@/app/api/internal/agent-tools/expose-service/route";
import { instanceServiceTokenOk } from "@/lib/cf-access.mjs";

function post(handler: (req: NextRequest) => Promise<Response>, url: string, body: unknown) {
  return handler(
    new NextRequest(`http://127.0.0.1:3000${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("agentTools shared logic", () => {
  it("createSuggestedTask creates a suggested task with the given priority", () => {
    const project = createProject({ name: "Shared" });
    const { task, text } = createSuggestedTask(project, { title: "Do X", description: "the X", priority: "hi" });
    const row = getTask(task.id)!;
    expect(row).toMatchObject({ title: "Do X", description: "the X", priority: "hi", suggested: 1, status: "not_started" });
    expect(text).toContain("Do X");
    expect(text).toContain(task.id);
  });

  it("wires blocked_by deps and drops unknown/foreign ids without throwing", () => {
    const project = createProject({ name: "Deps" });
    const a = createSuggestedTask(project, { title: "A", description: "" }).task;
    const b = createSuggestedTask(project, { title: "B", description: "", blocked_by: [a.id] });
    expect(getTaskDeps(b.task.id)).toEqual([a.id]);
    expect(b.text).toContain("Blocked by 1 task(s).");

    // An unknown id is silently dropped by setTaskDeps — no throw, real dep kept.
    const other = createProject({ name: "Deps2" });
    const foreign = createSuggestedTask(other, { title: "Foreign", description: "" }).task;
    const c = createSuggestedTask(project, { title: "C", description: "", blocked_by: [a.id, "ghost", foreign.id] });
    expect(getTaskDeps(c.task.id)).toEqual([a.id]);
  });

  it("resolveTitleRefs maps session titles to ids and passes ids through", () => {
    const map = new Map<string, string>([["First task", "id-1"]]);
    expect(resolveTitleRefs(["First task", "id-2"], map)).toEqual(["id-1", "id-2"]);
    expect(resolveTitleRefs(undefined, map)).toEqual([]);
  });

  it("registerExposedService records the port and returns a URL + text", () => {
    const project = createProject({ name: "Svc" });
    const { info, url, text } = registerExposedService(project, "dev", 4321);
    expect(info.port).toBe(4321);
    expect(url).toBeTruthy();
    expect(text).toContain("4321");
    expect(text).toContain(url);
  });
});

describe("internal agent-tool endpoints", () => {
  it("suggest-task creates a task and returns its id + text", async () => {
    const project = createProject({ name: "EP-Suggest" });
    const res = await post(suggestTask, "/api/internal/agent-tools/suggest-task", {
      projectId: project.id,
      title: "Endpoint task",
      description: "via HTTP",
      priority: "lo",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; id: string; text: string };
    expect(json.ok).toBe(true);
    expect(getTask(json.id)).toMatchObject({ title: "Endpoint task", priority: "lo", suggested: 1 });
    expect(json.text).toContain("Endpoint task");
  });

  it("suggest-task forwards resolved blocked_by ids to setTaskDeps", async () => {
    const project = createProject({ name: "EP-Deps" });
    const blocker = createSuggestedTask(project, { title: "Blocker", description: "" }).task;
    const res = await post(suggestTask, "/api/internal/agent-tools/suggest-task", {
      projectId: project.id,
      title: "Dependent",
      description: "",
      blocked_by: [blocker.id],
    });
    const json = (await res.json()) as { id: string };
    expect(getTaskDeps(json.id)).toEqual([blocker.id]);
  });

  it("suggest-task rejects an unknown project (404) and a missing title (400)", async () => {
    const bad = await post(suggestTask, "/api/internal/agent-tools/suggest-task", { projectId: "nope", title: "x" });
    expect(bad.status).toBe(404);
    const project = createProject({ name: "EP-Bad" });
    const noTitle = await post(suggestTask, "/api/internal/agent-tools/suggest-task", { projectId: project.id, title: "  " });
    expect(noTitle.status).toBe(400);
  });

  it("expose-service registers the service and returns the URL", async () => {
    const project = createProject({ name: "EP-Svc" });
    const res = await post(exposeService, "/api/internal/agent-tools/expose-service", {
      projectId: project.id,
      name: "api",
      port: 5555,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; name: string; url: string; text: string };
    expect(json.ok).toBe(true);
    expect(json.name).toBe("api");
    expect(json.url).toContain("5555");
    expect(json.text).toContain("5555");
  });

  it("expose-service rejects a non-positive / non-integer port (400)", async () => {
    const project = createProject({ name: "EP-Port" });
    for (const port of [0, -3, 1.5, "abc"]) {
      const res = await post(exposeService, "/api/internal/agent-tools/expose-service", {
        projectId: project.id,
        name: "x",
        port,
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("instance service token gate", () => {
  it("accepts the exact SERVICE_TOKEN and rejects the fleet token / empties", () => {
    const prev = process.env.SERVICE_TOKEN;
    const prevFleet = process.env.ORCH_FLEET_TOKEN;
    process.env.SERVICE_TOKEN = "secret-instance";
    process.env.ORCH_FLEET_TOKEN = "fleet-wide";
    try {
      expect(instanceServiceTokenOk("secret-instance")).toBe(true);
      // The read-only fleet token must NOT open the mutating endpoints.
      expect(instanceServiceTokenOk("fleet-wide")).toBe(false);
      expect(instanceServiceTokenOk("")).toBe(false);
      expect(instanceServiceTokenOk(null)).toBe(false);
    } finally {
      process.env.SERVICE_TOKEN = prev;
      process.env.ORCH_FLEET_TOKEN = prevFleet;
    }
  });
});
