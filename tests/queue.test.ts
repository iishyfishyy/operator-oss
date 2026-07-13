import { describe, expect, it } from "vitest";
import {
  createProject,
  createTask,
  addPendingMessage,
  listPendingMessages,
  popPendingMessage,
  deletePendingMessage,
  clearPendingMessages,
} from "../lib/store";

// The queue backing "follow-ups while a turn is running": messages typed
// mid-run are parked FIFO, then the runner pops the oldest one as the next turn.
describe("pending (queued) messages", () => {
  it("parks follow-ups, lists them FIFO, and pops the oldest first", () => {
    const project = createProject({ name: "Queue" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });

    addPendingMessage(task.id, 1, "first");
    addPendingMessage(task.id, 1, "second");
    addPendingMessage(task.id, 1, "third");

    expect(listPendingMessages(task.id).map((m) => m.content)).toEqual(["first", "second", "third"]);

    expect(popPendingMessage(task.id)?.content).toBe("first");
    expect(popPendingMessage(task.id)?.content).toBe("second");
    expect(listPendingMessages(task.id).map((m) => m.content)).toEqual(["third"]);

    expect(popPendingMessage(task.id)?.content).toBe("third");
    expect(popPendingMessage(task.id)).toBeUndefined(); // queue drained
    expect(listPendingMessages(task.id)).toEqual([]);
  });

  it("cancels one parked follow-up by id, leaving the rest in order", () => {
    const project = createProject({ name: "Queue2" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });

    const a = addPendingMessage(task.id, 1, "a");
    const b = addPendingMessage(task.id, 1, "b");
    const c = addPendingMessage(task.id, 1, "c");

    const removed = deletePendingMessage(b.id);
    expect(removed?.id).toBe(b.id);
    expect(listPendingMessages(task.id).map((m) => m.content)).toEqual(["a", "c"]);
    void a;
    void c;
  });

  it("clears the whole queue (e.g. on Stop) and returns what it removed", () => {
    const project = createProject({ name: "Queue3" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });

    addPendingMessage(task.id, 1, "x");
    addPendingMessage(task.id, 1, "y");

    expect(clearPendingMessages(task.id).map((m) => m.content)).toEqual(["x", "y"]);
    expect(listPendingMessages(task.id)).toEqual([]);
    expect(clearPendingMessages(task.id)).toEqual([]); // idempotent on an empty queue
  });

  it("scopes the queue per task", () => {
    const project = createProject({ name: "Queue4" });
    const t1 = createTask({ project_id: project.id, title: "T1", description: "" });
    const t2 = createTask({ project_id: project.id, title: "T2", description: "" });

    addPendingMessage(t1.id, 1, "for-t1");
    addPendingMessage(t2.id, 1, "for-t2");

    expect(listPendingMessages(t1.id).map((m) => m.content)).toEqual(["for-t1"]);
    expect(popPendingMessage(t1.id)?.content).toBe("for-t1");
    // t2's queue is untouched by draining t1.
    expect(listPendingMessages(t2.id).map((m) => m.content)).toEqual(["for-t2"]);
  });
});
