import { describe, it, expect, beforeEach, vi } from "vitest";

// After /clear, generation N+1 must open with a RESUME turn, not the day-one
// kickoff. The old behaviour reset `started` to 0 and so fell into the initial
// branch, telling the agent to "start working on the task" all over again —
// even though the previous generation's handoff summary was already in the
// system prompt — and silently discarding anything the user typed on that
// send. These tests drive the real /clear + POST /messages routes against a
// scripted fake driver and pin both halves.
const { runTurnMock, summarizeMock } = vi.hoisted(() => ({ runTurnMock: vi.fn(), summarizeMock: vi.fn() }));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown) => runTurnMock(task, project, userText, ac),
    summarizeTranscript: (transcript: string, project: unknown) => summarizeMock(transcript, project),
  },
}));

import { createProject, createTask, getTask, listMessages } from "@/lib/store";
import {
  buildResumePrompt,
  buildOpeningPrompt,
  buildInitialPrompt,
  buildProjectContext,
  INITIAL_TASK_PROMPT,
  RESUME_PROMPT_LEAD,
} from "@/lib/agents/shared";
import { subscribe } from "@/lib/events";
import { POST as messagesPost } from "@/app/api/tasks/[id]/messages/route";
import { POST as clearRoute } from "@/app/api/tasks/[id]/clear/route";
import { tmpDir } from "./helpers";

function post(taskId: string, text: string) {
  return messagesPost(new Request("http://test/messages", { method: "POST", body: JSON.stringify({ text }) }), {
    params: Promise.resolve({ id: taskId }),
  });
}

function clear(taskId: string) {
  return clearRoute(new Request("http://test/clear", { method: "POST" }), { params: Promise.resolve({ id: taskId }) });
}

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

// Run one full turn (the scripted driver opens a session and finishes).
async function turn(taskId: string, text: string) {
  const ended = turnEnd(taskId);
  const res = await post(taskId, text);
  await ended;
  return res;
}

beforeEach(() => {
  runTurnMock.mockReset();
  summarizeMock.mockReset();
  summarizeMock.mockResolvedValue("HANDOFF SUMMARY");
  runTurnMock.mockImplementation(async function* () {
    yield { type: "session", sessionId: "s1" };
    yield { type: "done", sessionId: "s1" };
  });
});

describe("buildResumePrompt / buildOpeningPrompt", () => {
  it("names the task and says to continue, without repeating the handoff summary", () => {
    const text = buildResumePrompt({ title: "Add rate limiting" });
    expect(text).toContain(RESUME_PROMPT_LEAD);
    expect(text).toContain('"Add rate limiting"');
    expect(text).toContain("Pick up where it left off");
    expect(text).not.toContain(INITIAL_TASK_PROMPT);
  });

  it("appends the user's own text instead of discarding it", () => {
    const text = buildResumePrompt({ title: "T" }, "  actually, start with the tests  ");
    expect(text.startsWith(RESUME_PROMPT_LEAD)).toBe(true);
    expect(text.endsWith("actually, start with the tests")).toBe(true);
    // Blank/whitespace sends leave the bare lead behind.
    expect(buildResumePrompt({ title: "T" }, "   ")).toBe(buildResumePrompt({ title: "T" }));
  });

  it("picks initial vs resume by generation", () => {
    const task = { title: "T", description: "d", generation: 1 };
    expect(buildOpeningPrompt(task)).toBe(buildInitialPrompt(task));
    expect(buildOpeningPrompt({ ...task, generation: 2 })).toBe(buildResumePrompt(task));
    expect(buildOpeningPrompt({ ...task, generation: 2 }, "hi")).toBe(buildResumePrompt(task, "hi"));
  });
});

describe("the first turn after /clear", () => {
  it("sends the resume prompt, not the kickoff, and keeps the summary in the system prompt only", async () => {
    const project = createProject({ name: "Resume", repo_path: tmpDir() });
    const task = createTask({ project_id: project.id, title: "Ship the thing", description: "all of it" });

    await turn(task.id, "");
    expect(runTurnMock.mock.calls[0][2]).toBe(buildInitialPrompt(task));

    await clear(task.id);
    const cleared = getTask(task.id)!;
    expect(cleared.generation).toBe(2);
    expect(cleared.started).toBe(0); // still an "opening" turn by the old marker…

    await turn(task.id, "");
    // …but generation 2 opens with the resume prompt.
    const sent = runTurnMock.mock.calls[1][2] as string;
    expect(sent).toBe(buildResumePrompt(cleared));
    expect(sent).toContain(RESUME_PROMPT_LEAD);
    expect(sent).not.toBe(INITIAL_TASK_PROMPT);
    expect(sent).not.toContain(INITIAL_TASK_PROMPT);
    expect(sent).not.toBe(buildInitialPrompt(task));
    // The handoff summary has exactly one home: the system prompt.
    expect(sent).not.toContain("HANDOFF SUMMARY");
    const ctx = buildProjectContext(project, getTask(task.id)!);
    expect(ctx).toContain("HANDOFF SUMMARY");
    // …and the gen-1-only "the task text is also your first message" note is
    // gone, because for a resumed generation it isn't.
    expect(ctx).not.toContain("also the first user message");

    // The resume turn is a real, persisted user bubble in generation 2.
    const gen2 = listMessages(task.id).filter((m) => m.generation === 2 && m.role === "user");
    expect(gen2.map((m) => m.content)).toEqual([buildResumePrompt(cleared)]);
  });

  it("carries the user's typed message into the resume turn", async () => {
    const project = createProject({ name: "ResumeTyped", repo_path: tmpDir() });
    const task = createTask({ project_id: project.id, title: "Ship it", description: "d" });

    await turn(task.id, "");
    await clear(task.id);
    await turn(task.id, "skip the migration for now");

    const sent = runTurnMock.mock.calls[1][2] as string;
    expect(sent).toContain(RESUME_PROMPT_LEAD);
    expect(sent).toContain("skip the migration for now");
    expect(listMessages(task.id).filter((m) => m.generation === 2 && m.role === "user")[0].content).toBe(sent);
  });

  it("generation 3 resumes too — the marker is the generation, not a one-shot flag", async () => {
    const project = createProject({ name: "Resume3", repo_path: tmpDir() });
    const task = createTask({ project_id: project.id, title: "Long haul", description: "d" });

    await turn(task.id, "");
    await clear(task.id);
    await turn(task.id, "");
    await clear(task.id);
    await turn(task.id, "");

    expect(getTask(task.id)!.generation).toBe(3);
    expect(runTurnMock.mock.calls[2][2]).toBe(buildResumePrompt(task));
  });
});
