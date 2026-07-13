import { describe, it, expect, beforeEach, vi } from "vitest";

// Regression: the turn-launch TOCTOU. POST /messages used to check hasTurn()
// and only register the turn later, after awaits (worktree creation, base-branch
// sync) — so two rapid POSTs could both see "no turn", both start SDK turns on
// the SAME session in the same worktree, and the abort registry (keyed by task
// id) would only hold the second controller, leaving the first turn immune to
// Stop. Same class of gap on the other side of a turn's life: the finally
// unregistered before launching the dequeued follow-up (a POST in that window
// double-ran), and a Stop deleted the registry entry before the turn unwound
// (a successor turn started in that window had its running/queue state
// clobbered by the dying turn's finally). These tests drive a SCRIPTED fake
// driver through the real routes + runner and pin all three windows shut.
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: AbortController) =>
      runTurnMock(task, project, userText, ac),
  },
}));

import { createProject, createTask, getTask, listPendingMessages } from "@/lib/store";
import { startResumeTurn } from "@/lib/runner";
import { subscribe } from "@/lib/events";
import { hasTurn } from "@/lib/abort";
import { POST as messagesPost } from "@/app/api/tasks/[id]/messages/route";
import { POST as abortPost } from "@/app/api/tasks/[id]/abort/route";
import { tmpDir, makeRepo } from "./helpers";

function post(taskId: string, text: string) {
  return messagesPost(new Request("http://test/messages", { method: "POST", body: JSON.stringify({ text }) }), {
    params: Promise.resolve({ id: taskId }),
  });
}

function stop(taskId: string) {
  return abortPost(new Request("http://test/abort", { method: "POST" }), { params: Promise.resolve({ id: taskId }) });
}

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

// Let a resolved gate propagate through the parked generator and the runner's
// synchronous finally before asserting on the post-unwind state.
const settle = () => new Promise((r) => setTimeout(r, 25));

beforeEach(() => {
  runTurnMock.mockReset();
});

describe("turn-launch races", () => {
  it("two concurrent POSTs start exactly one turn; the other is queued", async () => {
    // A real git repo so the winning POST awaits ensureWorktree — exactly the
    // window where the old hasTurn check let the second POST through.
    const project = createProject({ name: "Race", repo_path: await makeRepo() });
    const task = createTask({ project_id: project.id, title: "T", description: "do the thing" });

    const gate = deferred();
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "s1" };
      await gate.promise;
      yield { type: "done", sessionId: "s1" };
    });

    const [r1, r2] = await Promise.all([post(task.id, "first"), post(task.id, "second")]);
    const bodies = [await r1.json(), await r2.json()];

    // Exactly one launched, exactly one parked — regardless of which POST won.
    expect(bodies.filter((b) => b.queued).length).toBe(1);
    expect(bodies.filter((b) => typeof b.generation === "number" && !b.queued).length).toBe(1);
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    expect(listPendingMessages(task.id)).toHaveLength(1);
    expect(hasTurn(task.id)).toBe(true);

    // Drain: the parked message runs as the next turn, then everything settles.
    const ended = turnEnd(task.id);
    gate.resolve();
    await ended;
    expect(runTurnMock).toHaveBeenCalledTimes(2);
    expect(listPendingMessages(task.id)).toHaveLength(0);
    expect(hasTurn(task.id)).toBe(false);
    expect(getTask(task.id)!.running).toBe(0);
  });

  it("Stop aborts the single active turn and discards its queue at press time", async () => {
    const project = createProject({ name: "StopRace", repo_path: await makeRepo() });
    const task = createTask({ project_id: project.id, title: "T", description: "d" });

    const gate = deferred();
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "s1" };
      await gate.promise;
      yield { type: "done", sessionId: "s1" };
    });

    await post(task.id, "");
    expect(hasTurn(task.id)).toBe(true);
    // A follow-up parked behind the live turn.
    expect((await (await post(task.id, "follow-up")).json()).queued).toBe(true);
    expect(listPendingMessages(task.id)).toHaveLength(1);

    const res = await stop(task.id);
    expect((await res.json()).aborted).toBe(true);
    // The one live controller was tripped (Stop can always reach the turn)…
    const controller = runTurnMock.mock.calls[0][3] as AbortController;
    expect(controller.signal.aborted).toBe(true);
    expect(hasTurn(task.id)).toBe(false);
    // …and the parked queue was discarded synchronously, at press time.
    expect(listPendingMessages(task.id)).toHaveLength(0);

    const ended = turnEnd(task.id);
    gate.resolve();
    await ended;
    expect(runTurnMock).toHaveBeenCalledTimes(1); // the follow-up never ran
    expect(getTask(task.id)!.running).toBe(0);
  });

  it("queue drain hands occupancy to the follow-up with no hasTurn gap", async () => {
    const project = createProject({ name: "DrainGap", repo_path: tmpDir("norepo-") });
    const task = createTask({ project_id: project.id, title: "T", description: "d" });

    const gateA = deferred();
    runTurnMock
      .mockImplementationOnce(async function* () {
        yield { type: "session", sessionId: "sA" };
        await gateA.promise;
        yield { type: "done", sessionId: "sA" };
      })
      .mockImplementationOnce(async function* () {
        yield { type: "session", sessionId: "sB" };
        yield { type: "done", sessionId: "sB" };
      });

    await startResumeTurn(task, project, "a");
    expect((await (await post(task.id, "b")).json()).queued).toBe(true);

    // The "dequeued" event is published inside the finishing turn's finally,
    // right as it launches the follow-up. Before the fix the finally had
    // already unregistered by then, so hasTurn read false there — the window
    // where a POST could start a parallel turn. Sample it at that instant.
    let occupiedAtHandoff: boolean | undefined;
    let turnEnds = 0;
    const unsub = subscribe(task.id, (ev) => {
      if (ev.type === "dequeued") occupiedAtHandoff = hasTurn(task.id);
      if (ev.type === "turn_end") turnEnds++;
    });

    const ended = turnEnd(task.id);
    gateA.resolve();
    await ended;
    unsub();

    expect(occupiedAtHandoff).toBe(true); // occupancy never lapsed
    expect(runTurnMock).toHaveBeenCalledTimes(2);
    expect(turnEnds).toBe(1); // only the follow-up's finally emits turn_end
    expect(hasTurn(task.id)).toBe(false);
  });

  it("a turn started after Stop is not clobbered by the dying turn's finally", async () => {
    const project = createProject({ name: "StopGap", repo_path: tmpDir("norepo-") });
    const task = createTask({ project_id: project.id, title: "T", description: "d" });

    // Turn A ignores its abort signal (stands in for an SDK turn that takes a
    // while to notice), so it unwinds only when we release its gate — well
    // after the successor has started.
    const gateA = deferred();
    const gateB = deferred();
    runTurnMock
      .mockImplementationOnce(async function* () {
        yield { type: "session", sessionId: "sA" };
        await gateA.promise;
        yield { type: "done", sessionId: "sA" };
      })
      .mockImplementationOnce(async function* () {
        yield { type: "session", sessionId: "sB" };
        await gateB.promise;
        yield { type: "done", sessionId: "sB" };
      })
      .mockImplementationOnce(async function* () {
        yield { type: "session", sessionId: "sC" };
        yield { type: "done", sessionId: "sC" };
      });

    await startResumeTurn(task, project, "a");
    expect((await (await stop(task.id)).json()).aborted).toBe(true);
    expect(hasTurn(task.id)).toBe(false); // slot free the moment Stop lands

    // Successor turn B starts while A is still unwinding, and gets a follow-up
    // queued behind it.
    await startResumeTurn(getTask(task.id)!, project, "b");
    expect(hasTurn(task.id)).toBe(true);
    expect((await (await post(task.id, "c")).json()).queued).toBe(true);

    let turnEnds = 0;
    const unsub = subscribe(task.id, (ev) => {
      if (ev.type === "turn_end") turnEnds++;
    });

    // Now let A's finally run. It must defer to the live successor: no
    // running=0 write, no queue clearing, no turn_end.
    gateA.resolve();
    await settle();
    expect(getTask(task.id)!.running).toBe(1); // B still owns the task row
    expect(hasTurn(task.id)).toBe(true);
    expect(listPendingMessages(task.id).map((m) => m.content)).toEqual(["c"]); // B's queue survived
    expect(turnEnds).toBe(0);

    // B finishes and drains "c" as turn C; only C's finally emits turn_end.
    const ended = turnEnd(task.id);
    gateB.resolve();
    await ended;
    unsub();
    expect(runTurnMock).toHaveBeenCalledTimes(3);
    expect(listPendingMessages(task.id)).toHaveLength(0);
    expect(getTask(task.id)!.running).toBe(0);
    expect(hasTurn(task.id)).toBe(false);
  });
});
