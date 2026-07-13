import { describe, expect, it } from "vitest";
import { createProject, createTask, deleteProject, addMessage } from "../lib/store";
import { publishTurnError } from "../lib/runner";
import { registerTurn, unregisterTurn, hasTurn, abortTurn } from "../lib/abort";
import { subscribe } from "../lib/events";

// Regression: deleting a project (or task) while a turn is live must never crash
// the shared server process. The runner keeps writing to SQLite after the task
// row is cascade-deleted, so those writes hit FOREIGN KEY errors; the fix makes
// the error path swallow-and-log instead of throwing out of the detached turn.
describe("project/task delete mid-turn", () => {
  it("addMessage on a deleted task row hits a FOREIGN KEY error (the hazard)", () => {
    const project = createProject({ name: "DelHazard" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    deleteProject(project.id); // cascade-drops the task row
    // This is exactly what the runner does mid-stream — and why the error path
    // must be hardened.
    expect(() => addMessage(task.id, 1, "assistant", "hi")).toThrow(/FOREIGN KEY/i);
  });

  it("publishTurnError degrades gracefully when the task row is gone (no throw)", () => {
    const project = createProject({ name: "DelErr" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    deleteProject(project.id);
    // Before the fix this re-threw a FOREIGN KEY error that escaped the runner's
    // catch and, unhandled on the detached run(), crashed the process.
    expect(() => publishTurnError(task.id, 1, "boom")).not.toThrow();
  });

  it("publishTurnError still persists + fans out for a live task", () => {
    const project = createProject({ name: "LiveErr" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    const seen: unknown[] = [];
    const unsub = subscribe(task.id, (e) => seen.push(e));
    publishTurnError(task.id, 1, "still broken");
    unsub();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "error", generation: 1 });
    // A real DB row id means it persisted (didn't fall through the catch).
    expect((seen[0] as { msgId?: string }).msgId).toBeTruthy();
  });

  it("abortTurn trips the live turn's controller so the runner can unwind", () => {
    const project = createProject({ name: "DelAbort" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    const controller = new AbortController();
    registerTurn(task.id, controller);
    expect(hasTurn(task.id)).toBe(true);
    // The project DELETE handler calls this for each task before teardown.
    expect(abortTurn(task.id)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(hasTurn(task.id)).toBe(false);
    unregisterTurn(task.id, controller); // no-op; already cleared
  });
});
