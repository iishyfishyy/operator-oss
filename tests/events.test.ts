// The in-process event bus (lib/events.ts): per-task channels plus the
// wildcard/global channel behind GET /api/events. The invariants that matter:
// a global listener sees every task's publishes (with the task id attached),
// unsubscribing detaches cleanly, and one throwing subscriber — per-task or
// global — never breaks delivery to the others or to the turn publishing.
import { describe, it, expect } from "vitest";
import { subscribe, subscribeGlobal, publish } from "@/lib/events";
import type { TaskStreamEvent } from "@/lib/types";

const turnEnd: TaskStreamEvent = { type: "turn_end" };
const notice: TaskStreamEvent = { type: "notice", content: "hi" };

describe("event bus global channel", () => {
  it("delivers every task's events to a global listener, with the task id", () => {
    const seen: [string, TaskStreamEvent][] = [];
    const unsub = subscribeGlobal((taskId, ev) => seen.push([taskId, ev]));
    try {
      publish("task-a", turnEnd);
      publish("task-b", notice);
      expect(seen).toEqual([
        ["task-a", turnEnd],
        ["task-b", notice],
      ]);
    } finally {
      unsub();
    }
  });

  it("reaches global listeners even with zero per-task subscribers", () => {
    let count = 0;
    const unsub = subscribeGlobal(() => count++);
    try {
      publish("task-with-no-viewers", turnEnd);
      expect(count).toBe(1);
    } finally {
      unsub();
    }
  });

  it("stops delivering after unsubscribe", () => {
    let count = 0;
    const unsub = subscribeGlobal(() => count++);
    publish("t", turnEnd);
    unsub();
    publish("t", turnEnd);
    expect(count).toBe(1);
  });

  it("a throwing subscriber never breaks the others or the publisher", () => {
    const seen: string[] = [];
    const unsubs = [
      subscribe("t", () => { throw new Error("dead per-task viewer"); }),
      subscribe("t", () => seen.push("task")),
      subscribeGlobal(() => { throw new Error("dead global viewer"); }),
      subscribeGlobal(() => seen.push("global")),
    ];
    try {
      expect(() => publish("t", turnEnd)).not.toThrow();
      expect(seen).toEqual(["task", "global"]);
    } finally {
      for (const u of unsubs) u();
    }
  });
});
