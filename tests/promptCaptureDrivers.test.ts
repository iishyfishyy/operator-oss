import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { queryMock, runMock } = vi.hoisted(() => ({ queryMock: vi.fn(), runMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn(() => ({})),
}));
vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    startThread() { return { id: null, runStreamed: runMock }; }
    resumeThread(id: string) { return { id, runStreamed: runMock }; }
  },
}));
import { claudeDriver } from "@/lib/agents/claude/driver";
import { codexDriver } from "@/lib/agents/codex/driver";
import { listPromptCaptures, promptScope } from "@/lib/promptCapture";
import { createProject, createTask } from "@/lib/store";
import { buildInitialPrompt } from "@/lib/agents/shared";

beforeEach(() => {
  process.env.ORCH_DEBUG_PROMPTS = "1";
  queryMock.mockImplementation(async function* () {});
  runMock.mockResolvedValue({ events: (async function* () {})() });
});
afterEach(() => { delete process.env.ORCH_DEBUG_PROMPTS; vi.clearAllMocks(); });
const drain = async (events: AsyncIterable<unknown>) => { for await (const _ of events) { /* consume */ } };

it("records the actual Claude SDK arguments including the attachment instruction on resumed turns", async () => {
  const project = createProject({ name: "Claude" });
  const task = createTask({ project_id: project.id, title: "Inspect" });
  const text = "[Attached file: /tmp/example.txt]";
  await drain(claudeDriver.runTurn({ ...task, session_id: "existing" }, project, text));
  const [capture] = listPromptCaptures(project.id, task.id);
  const args = queryMock.mock.calls[0][0];
  expect(capture.prompt).toBe(args.prompt);
  expect(capture.prompt).toContain("Read each attached image/file");
  expect(capture.systemAppend).toBe(args.options.systemPrompt.append);
  expect(capture.sessionId).toBe("existing");
  expect(capture.options).not.toHaveProperty("env");
  expect(capture.options.mcpServers).toEqual(["orchestrator"]);
});

it("records combined Codex fresh input and only user input on resume", async () => {
  const project = createProject({ name: "Codex" });
  const task = createTask({ project_id: project.id, title: "Inspect", description: "Find duplicated instructions.", agent: "codex" });
  const text = buildInitialPrompt(task);
  await drain(codexDriver.runTurn(task, project, text));
  let [capture] = listPromptCaptures(project.id, task.id);
  expect(capture.prompt).toBe(runMock.mock.calls[0][0]);
  expect(capture.sections.map(s => s.text).join("")).toBe(capture.prompt);
  expect(capture.prompt).toContain("Task details:");
  await drain(codexDriver.runTurn({ ...task, session_id: "existing" }, project, "  continue\n"));
  [capture] = listPromptCaptures(project.id, task.id);
  expect(capture.prompt).toBe(runMock.mock.calls[1][0]);
  expect(capture.prompt).toBe("  continue\n");
  expect(capture.sessionId).toBe("existing");
  expect(JSON.stringify(capture.options)).not.toContain("token");
});

it("captures internal jobs with the correct scope across concurrent agents", async () => {
  const project = createProject({ name: "Internal jobs" });
  const task = createTask({ project_id: project.id, title: "Inspect" });
  await Promise.all([
    promptScope.run({ projectId: project.id, taskId: task.id, job: "summarizeTranscript" },
      () => claudeDriver.summarizeTranscript!("transcript", project)),
    promptScope.run({ projectId: project.id, job: "summarizeProjectRecap" },
      () => codexDriver.summarizeProjectRecap!(project, "digest")),
  ]);
  const captures = listPromptCaptures(project.id, task.id);
  expect(captures.find(c => c.agent === "claude")).toMatchObject({ taskId: task.id, job: "summarizeTranscript", prompt: queryMock.mock.calls[0][0].prompt });
  expect(captures.find(c => c.agent === "codex")).toMatchObject({ job: "summarizeProjectRecap", prompt: runMock.mock.calls[0][0] });
  expect(captures.find(c => c.agent === "codex")?.taskId).toBeUndefined();
});
