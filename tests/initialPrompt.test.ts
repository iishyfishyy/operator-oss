import { describe, it, expect, vi } from "vitest";

// The opening user turn of a fresh session is the task itself (title heading +
// description + kickoff line), so the transcript's first bubble tells the user
// what the session was asked to do. A task with no description falls back to
// the generic INITIAL_TASK_PROMPT. Both the POST route and the auto-start
// pipeline go through the same helper; this pins the helper and the route's
// fallback end-to-end (tests/turnRace.test.ts and tests/autoStart.test.ts pin
// the described-task path through each launcher).
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: AbortController) =>
      runTurnMock(task, project, userText, ac),
  },
}));

import { createProject, createTask, listMessages } from "@/lib/store";
import { buildInitialPrompt, buildProjectContext, INITIAL_TASK_PROMPT, INITIAL_PROMPT_KICKOFF } from "@/lib/agents/shared";
import { subscribe } from "@/lib/events";
import { POST as messagesPost } from "@/app/api/tasks/[id]/messages/route";
import { tmpDir } from "./helpers";

function turnEnd(taskId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const unsub = subscribe(taskId, (ev) => {
      if (ev.type === "turn_end") {
        unsub();
        resolve();
      }
    });
  });
}

describe("buildInitialPrompt", () => {
  it("renders the task as title heading + description + kickoff line", () => {
    const text = buildInitialPrompt({ title: "Add rate limiting", description: "Per-IP, 100 req/min.\n\nUse the existing middleware." });
    expect(text).toBe(`# Add rate limiting\n\nPer-IP, 100 req/min.\n\nUse the existing middleware.\n\n${INITIAL_PROMPT_KICKOFF}`);
  });

  it("falls back to the generic prompt when the description is empty or whitespace", () => {
    expect(buildInitialPrompt({ title: "Title only", description: "" })).toBe(INITIAL_TASK_PROMPT);
    expect(buildInitialPrompt({ title: "Title only", description: "   \n" })).toBe(INITIAL_TASK_PROMPT);
  });

  it("trims stray whitespace around the title and description", () => {
    expect(buildInitialPrompt({ title: "  T  ", description: "\n d \n" })).toBe(`# T\n\nd\n\n${INITIAL_PROMPT_KICKOFF}`);
  });

  it("the project context flags the duplicated task text only when a description exists", () => {
    const project = createProject({ name: "Ctx", repo_path: tmpDir() });
    const described = createTask({ project_id: project.id, title: "A", description: "details" });
    const bare = createTask({ project_id: project.id, title: "B", description: "" });
    expect(buildProjectContext(project, described)).toContain("also the first user message");
    expect(buildProjectContext(project, bare)).not.toContain("also the first user message");
    expect(buildProjectContext(project, bare)).toContain('The current task is: "B"');
  });
});

describe("POST /messages opening turn", () => {
  it("persists and sends the generic prompt for a task with no description", async () => {
    const project = createProject({ name: "Fallback", repo_path: tmpDir() });
    const task = createTask({ project_id: project.id, title: "Only a title" });
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "s1" };
      yield { type: "done", sessionId: "s1" };
    });
    const ended = turnEnd(task.id);
    const res = await messagesPost(new Request("http://test/messages", { method: "POST", body: JSON.stringify({ text: "" }) }), {
      params: Promise.resolve({ id: task.id }),
    });
    expect(res.status).toBe(202);
    await ended;
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    expect(runTurnMock.mock.calls[0][2]).toBe(INITIAL_TASK_PROMPT);
    expect(listMessages(task.id).map((m) => [m.role, m.content])).toEqual([["user", INITIAL_TASK_PROMPT]]);
  });
});
