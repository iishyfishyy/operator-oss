// The ask round-trip through the real runner + the mock driver, pinned at the
// row/wire level the UI reads: the "thinking" dots are `running && !awaiting_
// input` (isThinking), so every transition here is asserted on the persisted
// task row AND on the snapshot the global /api/events stream would publish
// (the row re-read at publish time — persist-then-publish).
//
// The bug this guards: the dots used to derive "parked" from "any unanswered
// ask card in the transcript". A card left behind by a Stop (or a restart)
// stayed unanswered in the DB forever — and the old /answer fallback started a
// fresh turn without settling it — so the dots vanished for every later turn.
import { describe, it, expect, beforeAll } from "vitest";
import { makeRepo } from "./helpers";
import { createProject, createTask, getTask, listMessages } from "@/lib/store";
import { startResumeTurn } from "@/lib/runner";
import { subscribe, subscribeGlobal } from "@/lib/events";
import { abortTurn, hasTurn } from "@/lib/abort";
import { POST as answerRoute } from "@/app/api/tasks/[id]/answer/route";
import { isThinking } from "@/app/orchestrator/format";
import { formatAnswersReply } from "@/lib/askFormat";
import type { TaskStreamEvent, ToolData } from "@/lib/types";
import type { TaskRow } from "@/app/orchestrator/types";

// Registers the deterministic mock driver (lib/agents/mock/). The registry is
// built lazily on first resolve, so setting the flag here is early enough.
process.env.ORCH_E2E_MOCK_AGENT = "1";

type Snap = { event: string; running: boolean; awaiting_input: boolean };

// Per-task events plus, for each bus event, the task row as the global
// /api/events relay would read it at publish time.
function watch(taskId: string) {
  const events: TaskStreamEvent[] = [];
  const snaps: Snap[] = [];
  let endResolve!: () => void;
  const ended = new Promise<void>((r) => (endResolve = r));
  const unsub = subscribe(taskId, (ev) => {
    events.push(ev);
    if (ev.type === "turn_end") endResolve();
  });
  const unsubGlobal = subscribeGlobal((id, ev) => {
    if (id !== taskId) return;
    const t = getTask(taskId);
    if (t) snaps.push({ event: ev.type, running: !!t.running, awaiting_input: !!t.awaiting_input });
  });
  return { events, snaps, ended, stop: () => { unsub(); unsubGlobal(); } };
}

async function until(cond: () => boolean, label: string, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const row = (id: string) => getTask(id) as unknown as TaskRow;
const dots = (id: string) => isThinking(row(id), hasTurn(id));

async function answer(id: string, askId: string, answers: string[][]) {
  const res = await answerRoute(
    new Request(`http://test/api/tasks/${id}/answer`, { method: "POST", body: JSON.stringify({ askId, answers }) }),
    { params: Promise.resolve({ id }) }
  );
  return (await res.json()) as { resolved: boolean; resumed: boolean };
}

let repo: string;
beforeAll(async () => {
  repo = await makeRepo();
});

function setup(name: string) {
  const project = createProject({ name, repo_path: repo } as Parameters<typeof createProject>[0]);
  const task = createTask({ project_id: project.id, title: name, description: "e2e:ask=Which color?|Red|Blue", agent: "mock" });
  return { project, task };
}

describe("ask → answer → dots → turn end (live turn)", () => {
  it("parks with the dots off, resumes with them on, and the global snapshot agrees at every step", async () => {
    const { project, task } = setup("AskLive");
    const w = watch(task.id);
    await startResumeTurn(task, project, "go");

    // Parked: turn live, row flagged, dots OFF — and that's what the global
    // relay saw when the ask was published (row persisted before publish).
    await until(() => w.events.some((e) => e.type === "ask"), "ask");
    const ask = w.events.find((e) => e.type === "ask") as Extract<TaskStreamEvent, { type: "ask" }>;
    expect(row(task.id)).toMatchObject({ running: 1, awaiting_input: 1 });
    expect(dots(task.id)).toBe(false);
    expect(w.snaps.find((s) => s.event === "ask")).toEqual({ event: "ask", running: true, awaiting_input: true });

    // Answer through the real route: the parked driver takes it in-process.
    expect(await answer(task.id, ask.id, [["Red"]])).toEqual({ resolved: true, resumed: false });
    await until(() => w.events.some((e) => e.type === "ask_answered"), "ask_answered");
    const answered = w.events.find((e) => e.type === "ask_answered") as Extract<TaskStreamEvent, { type: "ask_answered" }>;
    // The event carries the settled verdict (no other ask still parked) and
    // updates the card the ask created.
    expect(answered).toMatchObject({ id: ask.id, answers: [["Red"]], msgId: ask.msgId, awaiting_input: false });
    // Working again: dots ON, and the global relay's snapshot for ask_answered
    // already read running=1 / awaiting_input=0.
    expect(row(task.id)).toMatchObject({ running: 1, awaiting_input: 0 });
    expect(dots(task.id)).toBe(true);
    expect(w.snaps.find((s) => s.event === "ask_answered")).toEqual({ event: "ask_answered", running: true, awaiting_input: false });

    // The turn keeps going and ends normally.
    await w.ended;
    w.stop();
    expect(row(task.id)).toMatchObject({ running: 0, awaiting_input: 1 });
    expect(dots(task.id)).toBe(false);
    const card = listMessages(task.id).find((m) => m.role === "tool" && m.content.includes('"ask"'))!;
    expect((JSON.parse(card.content) as ToolData).ask).toMatchObject({ id: ask.id, answers: [["Red"]] });
    expect(w.events.map((e) => e.type).slice(-2)).toEqual(["done", "turn_end"]);
  });
});

describe("answering a card whose turn is gone (Stop while parked)", () => {
  it("settles the card, resumes the session, and publishes ask_answered only after running=1 is persisted", async () => {
    const { project, task } = setup("AskStale");
    let w = watch(task.id);
    await startResumeTurn(task, project, "go");
    await until(() => w.events.some((e) => e.type === "ask"), "ask");
    const ask = w.events.find((e) => e.type === "ask") as Extract<TaskStreamEvent, { type: "ask" }>;

    // Stop while parked: the turn ends, the card stays in the transcript
    // unanswered (still answerable), nothing is parked in the registry.
    expect(abortTurn(task.id)).toBe(true);
    await w.ended;
    w.stop();
    expect(row(task.id)).toMatchObject({ running: 0, awaiting_input: 1 });
    const before = listMessages(task.id).find((m) => m.id === ask.msgId)!;
    expect((JSON.parse(before.content) as ToolData).ask?.answers).toBeUndefined();

    // Answer it now. Nothing is waiting → the route settles the card and
    // resumes the session itself.
    w = watch(task.id);
    expect(await answer(task.id, ask.id, [["Blue"]])).toEqual({ resolved: false, resumed: true });

    // Persisted: the card carries its answers, the row is running and no
    // longer awaiting → dots ON before any client roundtrip.
    const after = listMessages(task.id).find((m) => m.id === ask.msgId)!;
    expect((JSON.parse(after.content) as ToolData).ask).toMatchObject({ id: ask.id, answers: [["Blue"]] });
    expect(row(task.id)).toMatchObject({ running: 1, awaiting_input: 0 });
    expect(dots(task.id)).toBe(true);

    // Published in persist-then-publish order: the resumed turn's `user` echo
    // (→ global turn_started) precedes ask_answered, and the relay's snapshot
    // for ask_answered already reads "working again".
    const types = w.events.map((e) => e.type);
    expect(types.indexOf("user")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("ask_answered")).toBeGreaterThan(types.indexOf("user"));
    const answered = w.events.find((e) => e.type === "ask_answered") as Extract<TaskStreamEvent, { type: "ask_answered" }>;
    expect(answered).toMatchObject({ id: ask.id, answers: [["Blue"]], msgId: ask.msgId, awaiting_input: false });
    expect(w.snaps.find((s) => s.event === "user")).toEqual({ event: "user", running: true, awaiting_input: false });
    expect(w.snaps.find((s) => s.event === "ask_answered")).toEqual({ event: "ask_answered", running: true, awaiting_input: false });

    // The reply that resumed the session is the answers, phrased as a message.
    const questions = (JSON.parse(after.content) as ToolData).ask!.questions;
    const users = listMessages(task.id).filter((m) => m.role === "user");
    expect(users[users.length - 1].content).toBe(formatAnswersReply(questions, [["Blue"]]));

    await w.ended;
    w.stop();
    expect(row(task.id)).toMatchObject({ running: 0, awaiting_input: 1 });
    expect(dots(task.id)).toBe(false);
  });

  it("answers nobody is waiting for and no card carries are still a plain resume", async () => {
    const { project, task } = setup("AskGhost");
    // Give the task a session so the resume path has something to continue.
    const w = watch(task.id);
    await startResumeTurn(task, project, "go");
    await until(() => w.events.some((e) => e.type === "ask"), "ask");
    const ask = w.events.find((e) => e.type === "ask") as Extract<TaskStreamEvent, { type: "ask" }>;
    await answer(task.id, ask.id, [["Red"]]);
    await w.ended;
    w.stop();

    const w2 = watch(task.id);
    expect(await answer(task.id, "no-such-ask", [["Red"]])).toEqual({ resolved: false, resumed: true });
    expect(row(task.id)).toMatchObject({ running: 1, awaiting_input: 0 });
    // No card to update → no ask_answered is published for a phantom id.
    await w2.ended;
    w2.stop();
    expect(w2.events.some((e) => e.type === "ask_answered")).toBe(false);
  });
});
