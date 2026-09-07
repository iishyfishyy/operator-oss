import { beforeEach, describe, expect, it, vi } from "vitest";

// Pin the launch at the runner boundary: auto-start's job is deciding WHEN to
// start a task and handing the runner a correctly prepared launch; the turn
// itself is the driver-contract test's problem (tests/agentDriver.test.ts).
vi.mock("@/lib/runner", () => ({ startTurn: vi.fn() }));

import { startTurn } from "@/lib/runner";
import {
  createProject,
  createTask,
  getTask,
  listMessages,
  setTaskDeps,
  updateTask,
} from "../lib/store";
import { maybeAutoStartDependents, readyAutoStartDependents } from "../lib/autoStart";
import { hasTurn } from "../lib/abort";
import { buildInitialPrompt, buildProjectContext } from "../lib/agents/shared";
import { tmpDir } from "./helpers";
import type { Task } from "../lib/types";

const startTurnMock = vi.mocked(startTurn);

function makeProject() {
  // A plain (non-git) working dir: ensureWorktree falls back to repo_path,
  // which is exactly the launch path we want to keep out of these tests.
  return createProject({ name: "Pipeline", repo_path: tmpDir("pipeline-") });
}

/** A blocks B; B has opted into auto-start unless told otherwise. */
function makeChain(autoStart = true) {
  const project = makeProject();
  const a = createTask({ project_id: project.id, title: "A" });
  const b = createTask({ project_id: project.id, title: "B", description: "build on A" });
  setTaskDeps(b.id, [a.id]);
  if (autoStart) updateTask(b.id, { auto_start: 1 });
  return { project, a, b };
}

// Launching hands the claimed turn slot to the (mocked) runner, which never
// releases it — free it so later tests can claim the same task id again... and
// because each test uses fresh task ids, just clearing the mock is enough.
beforeEach(() => startTurnMock.mockClear());

describe("readyAutoStartDependents (selection rules)", () => {
  it("a dependent with the toggle on is ready once its only blocker is done", () => {
    const { a, b } = makeChain();
    updateTask(a.id, { status: "done" });
    expect(readyAutoStartDependents(a.id).map((t) => t.id)).toEqual([b.id]);
  });

  it("toggle off = today's behavior: never selected", () => {
    const { a } = makeChain(false);
    updateTask(a.id, { status: "done" });
    expect(readyAutoStartDependents(a.id)).toEqual([]);
  });

  it("waits for the LAST blocker: an unfinished second dep keeps it back", () => {
    const { project, a, b } = makeChain();
    const c = createTask({ project_id: project.id, title: "C" });
    setTaskDeps(b.id, [a.id, c.id]);
    updateTask(a.id, { status: "done" });
    expect(readyAutoStartDependents(a.id)).toEqual([]);

    updateTask(c.id, { status: "done" });
    expect(readyAutoStartDependents(c.id).map((t) => t.id)).toEqual([b.id]);
  });

  it("a cancelled co-blocker doesn't hold the dependent back (matches the UI's blocked rule)", () => {
    const { project, a, b } = makeChain();
    const c = createTask({ project_id: project.id, title: "C" });
    setTaskDeps(b.id, [a.id, c.id]);
    updateTask(c.id, { status: "cancelled" });
    updateTask(a.id, { status: "done" });
    expect(readyAutoStartDependents(a.id).map((t) => t.id)).toEqual([b.id]);
  });

  it("never selects started, suggested, on-hold, or cancelled dependents", () => {
    const project = makeProject();
    const a = createTask({ project_id: project.id, title: "A" });
    const mk = (title: string, patch: Partial<Task>) => {
      const t = createTask({ project_id: project.id, title });
      setTaskDeps(t.id, [a.id]);
      updateTask(t.id, { auto_start: 1, ...patch });
      return t;
    };
    mk("already started", { started: 1 });
    mk("still a suggestion", { suggested: 1 });
    mk("parked by the user", { status: "on_hold" });
    mk("abandoned", { status: "cancelled" });
    updateTask(a.id, { status: "done" });
    expect(readyAutoStartDependents(a.id)).toEqual([]);
  });
});

describe("maybeAutoStartDependents (the launch)", () => {
  it("marking A done starts B without user action", async () => {
    const { a, b } = makeChain();
    updateTask(a.id, { status: "done" });
    maybeAutoStartDependents(a.id);
    // The launch initializes a real git repo + worktree — allow it a few seconds.
    await vi.waitFor(() => expect(startTurnMock).toHaveBeenCalledTimes(1), { timeout: 10_000 });

    // The runner gets the task text as its opening turn (same as the POST
    // route) plus the auto-start note; the injected project context carries
    // the same title/details and notes they're one and the same request.
    const [task, project, userText, note, controller] = startTurnMock.mock.calls[0];
    expect(task.id).toBe(b.id);
    expect(project.id).toBe(b.project_id);
    expect(userText).toBe(buildInitialPrompt(b));
    expect(userText).toContain("# B");
    expect(userText).toContain("build on A");
    const context = buildProjectContext(project, b);
    expect(context).toContain('The current task is: "B"');
    expect(context).toContain("Task details: build on A");
    expect(context).toContain("also the first user message");
    expect(note).toContain('"A" is done');
    expect(controller).toBeInstanceOf(AbortController);
    expect(hasTurn(b.id)).toBe(true);

    // Same pre-launch state the POST route leaves: prompt echoed to the
    // transcript, running flagged, `started` deferred until a session opens.
    expect(listMessages(b.id).map((m) => [m.role, m.content])).toEqual([["user", buildInitialPrompt(b)]]);
    const fresh = getTask(b.id)!;
    expect(fresh.running).toBe(1);
    expect(fresh.started).toBe(0);
  });

  it("toggle off preserves today's behavior: nothing launches", () => {
    const { a, b } = makeChain(false);
    updateTask(a.id, { status: "done" });
    maybeAutoStartDependents(a.id);
    // A would-be launch claims the turn slot synchronously before its first
    // await, so no-claim right here proves no launch is even in flight.
    expect(hasTurn(b.id)).toBe(false);
    expect(startTurnMock).not.toHaveBeenCalled();
    expect(listMessages(b.id)).toEqual([]);
    expect(getTask(b.id)!.running).toBe(0);
  });

  it("a task started in the race window isn't double-launched", () => {
    const { a, b } = makeChain();
    updateTask(a.id, { status: "done" });
    // Simulate the user pressing Start in the same instant (route marked it started).
    updateTask(b.id, { started: 1 });
    maybeAutoStartDependents(a.id);
    expect(hasTurn(b.id)).toBe(false);
    expect(startTurnMock).not.toHaveBeenCalled();
  });
});
