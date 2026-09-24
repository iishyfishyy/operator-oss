import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capturePrompt, contextSections, listPromptCaptures, promptScope } from "@/lib/promptCapture";
import { duplicateLines, promptDiff } from "@/lib/promptCaptureTypes";
import { createProject, createTask, deleteProject, deleteTask } from "@/lib/store";
import { getDb } from "@/lib/db";
import { buildInitialPrompt, buildProjectContext } from "@/lib/agents/shared";
import { GET } from "@/app/api/tasks/[id]/prompts/route";

beforeEach(() => { process.env.ORCH_DEBUG_PROMPTS = "1"; getDb().exec("DELETE FROM prompt_captures"); });
afterEach(() => { delete process.env.ORCH_DEBUG_PROMPTS; vi.restoreAllMocks(); });
function fixture() {
  const project = createProject({ name: "Inspector", context: "Line one\n\nLine two\n" });
  const task = createTask({ project_id: project.id, title: "Review inputs", description: "Check all context for duplicated instructions." });
  const input = { projectId: project.id, taskId: task.id, agent: "claude", sessionId: null, prompt: "  exact\n\ntext\n", options: {} };
  return { project, task, input };
}

describe("prompt capture", () => {
  it("is off by default, including the endpoint", async () => {
    const { task, input } = fixture(); delete process.env.ORCH_DEBUG_PROMPTS;
    capturePrompt(input);
    expect(getDb().prepare("SELECT COUNT(*) n FROM prompt_captures").get()).toEqual({ n: 0 });
    expect((await GET(new Request("http://localhost"), { params: Promise.resolve({ id: task.id }) })).status).toBe(404);
  });
  it("preserves exact input and section boundaries", () => {
    const { project, task, input } = fixture();
    const context = buildProjectContext(project, task);
    expect(contextSections(context).map(s => s.text).join("")).toBe(context);
    expect(duplicateLines(context + "\n" + buildInitialPrompt(task)).has(task.description)).toBe(true);
    capturePrompt({ ...input, systemAppend: context });
    expect(listPromptCaptures(project.id, task.id)[0]).toMatchObject({ prompt: input.prompt, systemAppend: context });
  });
  it("isolates task captures, includes project jobs, and cascades hard deletion", async () => {
    const { project, task, input } = fixture();
    const other = createTask({ project_id: project.id, title: "Other" });
    capturePrompt(input); capturePrompt({ ...input, taskId: other.id });
    await promptScope.run({ projectId: project.id, job: "summarizeProjectRecap" }, async () => {
      await Promise.resolve(); capturePrompt({ agent: "codex", sessionId: null, prompt: "recap", options: {} });
    });
    const captures = listPromptCaptures(project.id, task.id);
    expect(captures).toHaveLength(2);
    expect(captures.some(c => c.job === "summarizeProjectRecap" && !c.taskId)).toBe(true);
    const response = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: task.id }) });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).captures).toHaveLength(2);
    deleteTask(task.id);
    expect(getDb().prepare("SELECT COUNT(*) n FROM prompt_captures WHERE task_id = ?").get(task.id)).toEqual({ n: 0 });
    deleteProject(project.id);
    expect(getDb().prepare("SELECT COUNT(*) n FROM prompt_captures").get()).toEqual({ n: 0 });
  });
  it("bounds retention by count, size, and age without truncation", () => {
    const { project, task, input } = fixture();
    for (let i = 0; i < 205; i++) capturePrompt({ ...input, prompt: String(i) });
    expect(listPromptCaptures(project.id, task.id)).toHaveLength(200);
    expect(listPromptCaptures(project.id, task.id)[0].prompt).toBe("204");
    getDb().exec("UPDATE prompt_captures SET created_at = 0");
    expect(listPromptCaptures(project.id, task.id)).toHaveLength(0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    capturePrompt({ ...input, prompt: "x".repeat(8 * 1024 * 1024) });
    expect(listPromptCaptures(project.id, task.id)).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    for (let i = 0; i < 7; i++) capturePrompt({ ...input, prompt: "x".repeat(3 * 1024 * 1024) });
    const { total } = getDb().prepare("SELECT SUM(bytes) total FROM prompt_captures").get() as { total: number };
    expect(total).toBeLessThanOrEqual(32 * 1024 * 1024);
  });
  it("does not stop a provider call when persistence fails", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => capturePrompt({ projectId: "deleted", agent: "claude", sessionId: null, prompt: "private", options: {} })).not.toThrow();
    expect(console.warn).toHaveBeenCalledWith("[prompt inspector] Could not persist capture");
  });
  it("marks repeats only within the supplied text and gives a replacement diff", () => {
    const line = "A repeated instruction long enough to warrant highlighting.";
    expect(duplicateLines(`${line}\n\n${line}`)).toEqual(new Set([line]));
    expect(duplicateLines(line).size).toBe(0);
    expect(promptDiff("same\nold\nend", "same\nnew\nend")).toBe("  same\n- old\n+ new\n  end");
    expect(promptDiff("same", "same")).toBe("No text changes.");
  });
});
