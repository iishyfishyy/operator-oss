import { describe, it, expect, beforeEach, vi } from "vitest";

// Regression: merge/sync checked task.running once, then ran multi-second git
// operations — a POST /messages landing in that window launched the agent into
// the SAME worktree mid-commit, so `git add -A` staged half-written files (and
// mergeTask could land them into the base branch). The fix is a per-task
// exclusive lock (lib/taskLock.ts) held by BOTH the turn-launch path (messages
// route + queue drain) and the git-op routes. These tests drive a SCRIPTED fake
// driver through the real runner and routes (same seam as clearMidTurn.test.ts)
// and simulate a slow merge by holding the lock, then assert no turn starts
// writing until the git op releases it.
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown) => runTurnMock(task, project, userText, ac),
  },
}));

import { createProject, createTask, updateTask, addPendingMessage, listPendingMessages } from "@/lib/store";
import { startResumeTurn } from "@/lib/runner";
import { withTaskLock, isTaskLocked } from "@/lib/taskLock";
import { registerTurn, unregisterTurn, hasTurn } from "@/lib/abort";
import { subscribe } from "@/lib/events";
import { POST as messagesPOST } from "@/app/api/tasks/[id]/messages/route";
import { POST as mergePOST } from "@/app/api/tasks/[id]/merge/route";
import { POST as syncPOST } from "@/app/api/tasks/[id]/sync/route";
import { makeRepo } from "./helpers";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// Let every pending microtask/timer chain (route awaits, lock queue) settle.
const settle = () => new Promise((r) => setTimeout(r, 30));

// Resolve when the runner publishes the given event type for this task.
function nextEvent(taskId: string, type: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const unsub = subscribe(taskId, (ev) => {
      if (ev.type === type) {
        unsub();
        resolve();
      }
    });
  });
}

function post(taskId: string, text?: string) {
  return messagesPOST(
    new Request("http://test/messages", { method: "POST", body: JSON.stringify({ text }) }),
    { params: Promise.resolve({ id: taskId }) }
  );
}

beforeEach(() => {
  runTurnMock.mockReset();
});

describe("withTaskLock", () => {
  it("serializes holders FIFO per task and never overlaps them", async () => {
    const order: string[] = [];
    const gate = deferred();
    const first = withTaskLock("t1", async () => {
      order.push("first-start");
      await gate.promise;
      order.push("first-end");
    });
    const second = withTaskLock("t1", async () => {
      order.push("second-start");
    });
    await settle();
    expect(order).toEqual(["first-start"]); // second is queued, not interleaved
    expect(isTaskLocked("t1")).toBe(true);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
    expect(isTaskLocked("t1")).toBe(false); // last one out cleans up the entry
  });

  it("does not block other tasks' locks", async () => {
    const gate = deferred();
    const held = withTaskLock("t2", () => gate.promise);
    let ran = false;
    await withTaskLock("t3", () => {
      ran = true;
    });
    expect(ran).toBe(true);
    gate.resolve();
    await held;
  });

  it("releases on throw and rethrows", async () => {
    await expect(withTaskLock("t4", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    let ran = false;
    await withTaskLock("t4", () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

describe("merge vs turn launch (the TOCTOU race)", () => {
  it("a POST /messages waits out a slow git op and only launches after it releases", async () => {
    const project = createProject({ name: "LockRace", repo_path: await makeRepo() });
    const task = createTask({ project_id: project.id, title: "T", description: "do the thing" });

    const order: string[] = [];
    runTurnMock.mockImplementation(async function* () {
      order.push("turn-started");
      yield { type: "session", sessionId: "s1" };
      yield { type: "done", sessionId: "s1" };
    });

    // A merge mid-git-op: it holds the task lock exactly like the merge/sync
    // routes do, parked on a gate we control.
    const gitOpGate = deferred();
    const gitOp = withTaskLock(task.id, async () => {
      order.push("gitop-start");
      await gitOpGate.promise;
      order.push("gitop-end");
    });
    await settle();
    expect(order).toEqual(["gitop-start"]);

    // The incoming message must NOT start a turn while the git op runs — this
    // is the window where the old code began writing into the mid-commit tree.
    const ended = nextEvent(task.id, "turn_end");
    const posted = post(task.id);
    await settle();
    expect(runTurnMock).not.toHaveBeenCalled();
    // The POST claimed the turn slot BEFORE queueing on the lock (that's the
    // launch-TOCTOU guard), so the task reads occupied while it waits — a
    // second POST parks, and a merge arriving behind us would 409 — but the
    // agent itself must not have started writing.
    expect(hasTurn(task.id)).toBe(true);

    // Git op finishes → the parked launch proceeds, strictly after it.
    gitOpGate.resolve();
    await gitOp;
    const res = await posted;
    expect(res.status).toBe(202);
    await ended;
    expect(order).toEqual(["gitop-start", "gitop-end", "turn-started"]);
  });

  it("merge and sync 409 while a turn is live, even with running=0 in the DB", async () => {
    const project = createProject({ name: "Lock409", repo_path: await makeRepo() });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    updateTask(task.id, { worktree_path: "/nonexistent/wt", work_branch: "orch/x" });

    // A live turn per the in-process registry (the DB flag stays 0 — the lock
    // path must consult liveness, not the possibly-stale row).
    const ac = new AbortController();
    registerTurn(task.id, ac);
    try {
      const m = await mergePOST(new Request("http://test/merge", { method: "POST" }), {
        params: Promise.resolve({ id: task.id }),
      });
      expect(m.status).toBe(409);
      const s = await syncPOST(new Request("http://test/sync", { method: "POST" }), {
        params: Promise.resolve({ id: task.id }),
      });
      expect(s.status).toBe(409);
    } finally {
      unregisterTurn(task.id, ac);
    }
  });

  it("two racing POSTs can't double-launch: the loser parks its message instead", async () => {
    const project = createProject({ name: "LockDouble", repo_path: await makeRepo() });
    const task = createTask({ project_id: project.id, title: "T", description: "d" });

    const turnGate = deferred();
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "s1" };
      await turnGate.promise;
      yield { type: "done", sessionId: "s1" };
    });

    // Wedge the launch path behind a held lock and fire two POSTs into it.
    // The atomic claim decides the race on arrival: the winner owns the slot
    // (and waits out the lock), the loser parks its message — never two
    // concurrent turns on one worktree.
    const wedge = deferred();
    const held = withTaskLock(task.id, () => wedge.promise);
    const p1 = post(task.id, "one");
    const p2 = post(task.id, "two");
    await settle();
    expect(runTurnMock).not.toHaveBeenCalled();

    const ended = nextEvent(task.id, "turn_end");
    wedge.resolve();
    await held;
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect(runTurnMock).toHaveBeenCalledTimes(1); // exactly one turn launched
    const queued = [(await r1.json()) as { queued?: boolean }, (await r2.json()) as { queued?: boolean }];
    expect(queued.filter((b) => b.queued)).toHaveLength(1); // the loser parked
    expect(listPendingMessages(task.id)).toHaveLength(1);

    // Drain: the parked message runs as the next turn once the first ends.
    turnGate.resolve();
    await ended;
    expect(runTurnMock).toHaveBeenCalledTimes(2);
  });

  it("the queue drain waits for a lock grabbed in the turn-end gap", async () => {
    const project = createProject({ name: "LockDrain" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });

    const turnGate = deferred();
    runTurnMock.mockImplementationOnce(async function* () {
      yield { type: "session", sessionId: "s1" };
      await turnGate.promise;
      yield { type: "done", sessionId: "s1" };
    });
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "s2" };
      yield { type: "done", sessionId: "s2" };
    });

    await startResumeTurn(task, project, "go");
    addPendingMessage(task.id, task.generation, "follow-up");

    // A git op grabs the lock while the first turn is still streaming (legal —
    // it would 409 on its own hasTurn re-check, but here it stands in for one
    // that squeezed into the gap right after the turn unregistered).
    const gitOpGate = deferred();
    const gitOp = withTaskLock(task.id, () => gitOpGate.promise);

    // First turn ends; its drain pops the follow-up but must queue behind the
    // held lock instead of launching into the git op.
    const dequeued = nextEvent(task.id, "dequeued");
    turnGate.resolve();
    await dequeued;
    await settle();
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    // The finishing turn handed its occupancy slot to the follow-up before
    // queueing on the lock, so hasTurn never lapses across the drain (a POST
    // in this window queues instead of double-launching) — but the follow-up
    // agent itself must not have started while the git op holds the lock.
    expect(hasTurn(task.id)).toBe(true);

    const ended = nextEvent(task.id, "turn_end");
    gitOpGate.resolve();
    await gitOp;
    await ended;
    expect(runTurnMock).toHaveBeenCalledTimes(2); // follow-up ran after the git op
  });
});
