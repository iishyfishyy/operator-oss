import { describe, it, expect, beforeEach, vi } from "vitest";

// Regression: pressing "Start fresh context" (/clear) while a turn is still
// streaming must actually clear the session lineage. The old bug had /clear bump
// the generation + null the session while the live turn kept running, then the
// runner's finally wrote the OLD session id back — resurrecting the session
// /clear had just nulled, so the next send resumed stale context. These tests
// drive a SCRIPTED fake driver through the real runner (the same seam the
// contract test uses) so we can park a turn mid-stream, fire /clear, then let the
// old turn's finally run and assert it can't resurrect anything.
const { runTurnMock, summarizeMock } = vi.hoisted(() => ({ runTurnMock: vi.fn(), summarizeMock: vi.fn() }));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown) => runTurnMock(task, project, userText, ac),
    summarizeTranscript: (transcript: string, project: unknown) => summarizeMock(transcript, project),
  },
}));

import { createProject, createTask, getTask, getProject, addPendingMessage, listPendingMessages, listSummaries } from "@/lib/store";
import { startResumeTurn } from "@/lib/runner";
import { buildProjectContext } from "@/lib/agents/shared";
import { subscribe } from "@/lib/events";
import { hasTurn } from "@/lib/abort";
import { POST as clearRoute } from "@/app/api/tasks/[id]/clear/route";
import type { Task } from "@/lib/types";

// Resolve when the runner publishes turn_end for this task.
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

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function clear(taskId: string) {
  return clearRoute(new Request("http://test/clear", { method: "POST" }), { params: Promise.resolve({ id: taskId }) });
}

beforeEach(() => {
  runTurnMock.mockReset();
  summarizeMock.mockReset();
  summarizeMock.mockResolvedValue("HANDOFF SUMMARY");
});

describe("/clear during a live turn", () => {
  it("aborts the turn, advances the generation, and the old turn's finally cannot resurrect the session", async () => {
    const project = createProject({ name: "ClearMid" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });

    // A turn that opens a session, does a little work, then parks mid-stream on a
    // gate we control — standing in for a turn still streaming when /clear fires.
    const opened = deferred();
    const gate = deferred();
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "old-session" };
      yield { type: "assistant", content: "working…" };
      opened.resolve();
      await gate.promise;
      yield { type: "done", sessionId: "old-session" };
    });

    const ended = turnEnd(task.id);
    await startResumeTurn(task, project, "go");
    await opened.promise; // session opened; turn is live and parked
    expect(hasTurn(task.id)).toBe(true);

    // /clear mid-turn.
    const res = await clear(task.id);
    const body = (await res.json()) as { generation: number };
    expect(body.generation).toBe(2);

    // Aborting the live turn unregisters it immediately; the fresh generation is
    // reset with a null session.
    let t = getTask(task.id)!;
    expect(hasTurn(task.id)).toBe(false);
    expect(t.generation).toBe(2);
    expect(t.session_id).toBeNull();
    expect(t.started).toBe(0);

    // Now let the OLD turn run to completion — its finally must NOT write the old
    // session id back or re-arm running/awaiting_input against the new generation.
    gate.resolve();
    await ended;

    t = getTask(task.id)!;
    expect(t.session_id).toBeNull(); // not resurrected
    expect(t.generation).toBe(2);
    expect(t.started).toBe(0);
    expect(t.running).toBe(0);

    // The handoff summary was recorded exactly once, for the old generation.
    const summaries = listSummaries(task.id);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].generation).toBe(1);
  });

  it("drops old-generation queued follow-ups so they can't drain into the fresh session", async () => {
    const project = createProject({ name: "ClearQueue" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });

    const opened = deferred();
    const gate = deferred();
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "old-session" };
      opened.resolve();
      await gate.promise;
      yield { type: "done", sessionId: "old-session" };
    });

    const ended = turnEnd(task.id);
    await startResumeTurn(task, project, "go");
    await opened.promise;

    // A follow-up parked while the turn was running (old generation).
    addPendingMessage(task.id, task.generation, "stale follow-up");
    expect(listPendingMessages(task.id)).toHaveLength(1);

    await clear(task.id);

    // Queue is emptied by /clear regardless of the abort path.
    expect(listPendingMessages(task.id)).toHaveLength(0);

    gate.resolve();
    await ended;
    expect(listPendingMessages(task.id)).toHaveLength(0);
  });

  it("next send after /clear runs a genuinely fresh session with the summary injected once", async () => {
    const project = createProject({ name: "ClearFresh" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });

    // First turn runs to completion and opens session "s1".
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "s1" };
      yield { type: "assistant", content: "did some work" };
      yield { type: "done", sessionId: "s1" };
    });
    let ended = turnEnd(task.id);
    await startResumeTurn(task, project, "go");
    await ended;
    expect(getTask(task.id)!.session_id).toBe("s1");

    // Clear it (no live turn now — the normal post-turn /clear).
    const res = await clear(task.id);
    expect((await res.json()).generation).toBe(2);
    expect(getTask(task.id)!.session_id).toBeNull();
    expect(listSummaries(task.id)).toHaveLength(1);

    // Next send: the driver must receive a task with NO session id, so runTurn
    // resumes nothing and starts fresh (resume: undefined).
    let seenTask: Task | undefined;
    runTurnMock.mockImplementation(async function* (t: Task) {
      seenTask = t;
      yield { type: "session", sessionId: "s2" };
      yield { type: "done", sessionId: "s2" };
    });
    ended = turnEnd(task.id);
    await startResumeTurn(getTask(task.id)!, project, "continue");
    await ended;

    expect(seenTask?.session_id).toBeNull(); // fresh session, not a resume of s1

    // The prior-session summary is carried into the new context exactly once —
    // not doubled (the old bug injected it via both the resumed session and the
    // rebuilt project context).
    const ctx = buildProjectContext(getProject(project.id)!, getTask(task.id)!);
    expect(ctx.split("HANDOFF SUMMARY").length - 1).toBe(1);
  });
});
