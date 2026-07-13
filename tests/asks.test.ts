// The pending-ask registry (lib/asks.ts): one assistant message can carry
// several AskUserQuestion tool_uses, so a task may have multiple asks parked at
// once. Each must stay independently answerable — the P1 this guards against
// was a one-entry-per-task registry where the second ask silently orphaned the
// first hook's promise, deadlocking the turn until the 24h hook timeout.
import { describe, it, expect } from "vitest";
import { waitForAnswer, submitAnswer } from "@/lib/asks";
import type { AskQuestion } from "@/lib/types";

const q = (text: string): AskQuestion[] => [
  { question: text, header: "Test", options: [{ label: "yes" }, { label: "no" }] },
];

// Whether a promise has settled yet, without awaiting it.
async function settled(p: Promise<unknown>): Promise<boolean> {
  const marker = Symbol();
  const r = await Promise.race([p.catch(() => undefined), Promise.resolve(marker)]);
  return r !== marker;
}

describe("asks registry", () => {
  it("answers a single parked ask", async () => {
    const p = waitForAnswer("t1", "a1", q("one?"));
    expect(submitAnswer("t1", "a1", [["yes"]])).toBe(true);
    await expect(p).resolves.toEqual([["yes"]]);
  });

  it("returns false when nothing is waiting under that id", () => {
    expect(submitAnswer("t-none", "a-none", [["yes"]])).toBe(false);
  });

  it("keeps two concurrent asks on one task independently answerable", async () => {
    const p1 = waitForAnswer("t2", "a1", q("first?"));
    const p2 = waitForAnswer("t2", "a2", q("second?"));

    // Registering the second must not orphan the first.
    expect(await settled(p1)).toBe(false);

    // Answer in reverse order — each resolves with its own answers.
    expect(submitAnswer("t2", "a2", [["no"]])).toBe(true);
    await expect(p2).resolves.toEqual([["no"]]);
    expect(await settled(p1)).toBe(false);

    expect(submitAnswer("t2", "a1", [["yes"]])).toBe(true);
    await expect(p1).resolves.toEqual([["yes"]]);

    // Both consumed — nothing left to answer.
    expect(submitAnswer("t2", "a1", [["yes"]])).toBe(false);
    expect(submitAnswer("t2", "a2", [["no"]])).toBe(false);
  });

  it("does not cross-resolve asks between tasks", async () => {
    const pa = waitForAnswer("tA", "a1", q("A?"));
    const pb = waitForAnswer("tB", "a1", q("B?"));
    expect(submitAnswer("tA", "a1", [["yes"]])).toBe(true);
    await expect(pa).resolves.toEqual([["yes"]]);
    expect(await settled(pb)).toBe(false);
    expect(submitAnswer("tB", "a1", [["no"]])).toBe(true);
    await expect(pb).resolves.toEqual([["no"]]);
  });

  it("abort rejects all pending asks for the task and clears them", async () => {
    const ac = new AbortController();
    const p1 = waitForAnswer("t3", "a1", q("first?"), ac.signal);
    const p2 = waitForAnswer("t3", "a2", q("second?"), ac.signal);

    ac.abort();
    await expect(p1).rejects.toThrow("aborted");
    await expect(p2).rejects.toThrow("aborted");

    // Registry is clean — late answers fall through to the resume path.
    expect(submitAnswer("t3", "a1", [["yes"]])).toBe(false);
    expect(submitAnswer("t3", "a2", [["yes"]])).toBe(false);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(waitForAnswer("t4", "a1", q("late?"), ac.signal)).rejects.toThrow("aborted");
  });

  it("settles (not orphans) a prior ask re-registered under the same id", async () => {
    const p1 = waitForAnswer("t5", "dup", q("first?"));
    const p2 = waitForAnswer("t5", "dup", q("second?"));
    await expect(p1).rejects.toThrow("superseded");
    expect(submitAnswer("t5", "dup", [["yes"]])).toBe(true);
    await expect(p2).resolves.toEqual([["yes"]]);
  });
});
