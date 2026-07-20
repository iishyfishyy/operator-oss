import { describe, it, expect, beforeEach, vi } from "vitest";

// The driver contract test: feed a SCRIPTED fake driver through lib/runner.ts
// and assert the persistence + publish behavior downstream of the seam is
// unchanged — the runner must treat any driver that speaks the StreamEvent
// contract identically to the Claude driver. The fake replaces the Claude
// driver module, so the registry's getDriver("claude") resolution is exercised
// for real; only the SDK-driving module is swapped out.
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown) =>
      runTurnMock(task, project, userText, ac),
  },
}));

// The Codex CLI is mocked at the SDK boundary (@openai/codex-sdk) rather than at
// the driver module: the REAL lib/agents/codex/driver.ts runs — startThread,
// prompt seeding, and lib/agents/codex/events.ts normalization — while the
// spawned `codex` process is replaced by a fake thread that replays recorded
// JSONL ThreadEvents. That pins BOTH drivers to the same StreamEvent → runner
// contract from opposite ends of the seam.
const { codexRun } = vi.hoisted(() => ({ codexRun: { events: [] as unknown[] } }));

vi.mock("@openai/codex-sdk", () => {
  class FakeThread {
    id: string | null;
    constructor(id?: string | null) {
      this.id = id ?? null;
    }
    async runStreamed() {
      const self = this;
      const events = codexRun.events;
      return {
        events: (async function* () {
          for (const ev of events) {
            const e = ev as { type?: string; thread_id?: string };
            // The real SDK populates thread.id from thread.started; mirror that
            // so the driver reads the right id back after the stream drains.
            if (e.type === "thread.started" && e.thread_id) self.id = e.thread_id;
            yield ev;
          }
        })(),
      };
    }
    async run() {
      return { finalResponse: "" };
    }
  }
  class Codex {
    startThread() {
      return new FakeThread();
    }
    resumeThread(id: string) {
      return new FakeThread(id);
    }
  }
  return { Codex };
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { createProject, createTask, getTask, listMessages, getTaskUsage, listProjectSessions, updateProject, addPendingMessage, deleteProject } from "@/lib/store";
import { getDriver, listDrivers, DEFAULT_AGENT } from "@/lib/agents/registry";
import { startResumeTurn } from "@/lib/runner";
import { subscribe, subscribeGlobal } from "@/lib/events";
import type { StreamEvent, TaskStreamEvent, ToolData } from "@/lib/types";

// Collect every event the runner publishes for a task until turn_end.
function collectEvents(taskId: string): { events: TaskStreamEvent[]; done: Promise<void> } {
  const events: TaskStreamEvent[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const unsub = subscribe(taskId, (ev) => {
    events.push(ev);
    if (ev.type === "turn_end") {
      unsub();
      resolve();
    }
  });
  return { events, done };
}

function script(events: StreamEvent[]) {
  runTurnMock.mockImplementation(async function* () {
    for (const ev of events) yield ev;
  });
}

// Recorded codex JSONL (same fixtures the codex event-mapping unit test uses),
// replayed through the mocked SDK into the real codex driver.
function loadCodexFixture(name: string): unknown[] {
  const file = path.join(__dirname, "fixtures", "codex", name);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

beforeEach(() => {
  runTurnMock.mockReset();
  codexRun.events = [];
});

describe("agent registry", () => {
  it("resolves by id, falls back to the default driver on unknown/empty ids", () => {
    expect(getDriver("claude").id).toBe("claude");
    expect(getDriver("no-such-agent").id).toBe(DEFAULT_AGENT);
    expect(getDriver(null).id).toBe(DEFAULT_AGENT);
    expect(getDriver(undefined).id).toBe(DEFAULT_AGENT);
    // Codex is a registered driver and resolves to itself, not the fallback.
    expect(getDriver("codex").id).toBe("codex");
    expect(listDrivers().map((d) => d.id)).toEqual(expect.arrayContaining(["claude", "codex"]));
  });

  it("stamps new tasks with the project's default agent", () => {
    const project = createProject({ name: "AgentCol" });
    expect(project.default_agent).toBe("claude");
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    expect(task.agent).toBe("claude");
    // A project-level default flows into tasks created after it changes.
    updateProject(project.id, { default_agent: "codex" });
    const t2 = createTask({ project_id: project.id, title: "T2", description: "" });
    expect(t2.agent).toBe("codex");
    expect(getDriver(t2.agent).id).toBe("codex");
    // …and an unknown persisted agent still resolves to a runnable driver.
    updateProject(project.id, { default_agent: "ghost-agent" });
    const t3 = createTask({ project_id: project.id, title: "T3", description: "" });
    expect(t3.agent).toBe("ghost-agent");
    expect(getDriver(t3.agent).id).toBe(DEFAULT_AGENT);
  });
});

describe("driver contract through the runner", () => {
  it("persists and publishes a full scripted turn exactly like the Claude driver", async () => {
    const project = createProject({ name: "Contract" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });

    script([
      { type: "session", sessionId: "thread-abc" },
      { type: "model", model: "fake-model-1" },
      { type: "assistant", content: "Working on it." },
      { type: "tool", id: "t1", title: "❯ ls", detail: "ls" },
      { type: "tool_result", id: "t1", content: "file.txt", isError: false },
      { type: "ask", id: "a1", questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }] }] },
      { type: "ask_answered", id: "a1", answers: [["A"]] },
      { type: "notice", content: "Service live" },
      { type: "usage", usage: { cost_usd: 0.5, input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_creation_tokens: 40 } },
      { type: "suggested", title: "Follow-up idea" },
      { type: "done", sessionId: "thread-abc" },
    ]);

    const { events, done } = collectEvents(task.id);
    await startResumeTurn(task, project, "go");
    await done;

    // The driver received the task/project/prompt unmodified.
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    expect(runTurnMock.mock.calls[0][0].id).toBe(task.id);
    expect(runTurnMock.mock.calls[0][2]).toBe("go");

    // Task row settled: session opened → started/in_progress, the opaque
    // session id persisted verbatim, model badge recorded, turn over →
    // running off + awaiting the user.
    const after = getTask(task.id)!;
    expect(after).toMatchObject({
      started: 1,
      status: "in_progress",
      running: 0,
      awaiting_input: 1,
      session_id: "thread-abc",
      resolved_model: "fake-model-1",
    });

    // Session row recorded (and closed) with the driver's opaque id.
    const sessions = listProjectSessions(project.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].claude_session_id).toBe("thread-abc");
    expect(sessions[0].ended_at).not.toBeNull();

    // Usage persisted from the usage event.
    expect(getTaskUsage(task.id)).toMatchObject({ cost_usd: 0.5, total_tokens: 100, turns: 1 });

    // Transcript: user echo, assistant text, the tool call merged with its
    // result, the answered ask, and the notice — all persisted rows.
    const msgs = listMessages(task.id);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "system"]);
    expect(msgs[0].content).toBe("go");
    expect(msgs[1].content).toBe("Working on it.");
    const tool = JSON.parse(msgs[2].content) as ToolData;
    expect(tool).toMatchObject({ title: "❯ ls", detail: "ls", result: "file.txt", isError: false });
    const ask = JSON.parse(msgs[3].content) as ToolData;
    expect(ask.ask).toMatchObject({ id: "a1", answers: [["A"]] });
    expect(msgs[4].content).toBe("Service live");

    // Publish contract: every persisted event carries its DB message id so
    // reconnecting clients upsert instead of duplicating, and the stream ends
    // with done + turn_end.
    const byType = (t: string) => events.filter((e) => e.type === t);
    for (const t of ["user", "assistant", "tool", "tool_result", "ask", "ask_answered", "notice"]) {
      expect(byType(t)).toHaveLength(1);
      expect((byType(t)[0] as { msgId?: string }).msgId).toBeTruthy();
    }
    // tool_result / ask_answered update the row their tool / ask created.
    expect((byType("tool_result")[0] as { msgId?: string }).msgId).toBe((byType("tool")[0] as { msgId?: string }).msgId);
    expect((byType("ask_answered")[0] as { msgId?: string }).msgId).toBe((byType("ask")[0] as { msgId?: string }).msgId);
    expect(byType("session")).toHaveLength(1);
    expect(byType("suggested")).toHaveLength(1);
    expect(events.map((e) => e.type).slice(-2)).toEqual(["done", "turn_end"]);
  });

  it("persists a driver error event as a durable system line and still settles the task", async () => {
    const project = createProject({ name: "ContractErr" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });

    script([
      { type: "session", sessionId: "s-err" },
      { type: "error", content: "driver exploded" },
      { type: "done", sessionId: "s-err" },
    ]);

    const { events, done } = collectEvents(task.id);
    await startResumeTurn(task, project, "go");
    await done;

    // The error is in the transcript (not just streamed) with the ⚠ prefix.
    const errMsg = listMessages(task.id).find((m) => m.role === "system");
    expect(errMsg?.content).toBe("⚠ driver exploded");
    expect(events.some((e) => e.type === "error")).toBe(true);
    // The task is settled and resumable, not stuck running.
    expect(getTask(task.id)).toMatchObject({ running: 0, awaiting_input: 1, session_id: "s-err" });
  });

  it("keeps a task retryable when the driver never opens a session", async () => {
    const project = createProject({ name: "ContractNoOpen" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });

    script([{ type: "error", content: "could not start" }, { type: "done", sessionId: null }]);

    const { done } = collectEvents(task.id);
    await startResumeTurn(task, project, "go");
    await done;

    // No session event → started stays 0 (retryable) and nothing is awaiting input.
    expect(getTask(task.id)).toMatchObject({ started: 0, running: 0, awaiting_input: 0, session_id: null });
    expect(listProjectSessions(project.id)).toHaveLength(0);
  });

  it("feeds the wildcard channel with the task row already persisted (the /api/events invariant)", async () => {
    const project = createProject({ name: "ContractGlobal" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });

    script([
      { type: "session", sessionId: "s-global" },
      { type: "ask", id: "a1", questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }] }] },
      { type: "ask_answered", id: "a1", answers: [["A"]] },
      { type: "done", sessionId: "s-global" },
    ]);

    // The global /api/events route builds each payload by re-reading the task
    // row when an event lands on the wildcard channel — so the runner MUST
    // persist before it publishes. Snapshot the row inside the listener, at
    // exactly the moment the route would read it.
    const seen: { taskId: string; type: string; running: number; awaiting: number }[] = [];
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const unsub = subscribeGlobal((taskId, ev) => {
      const t = getTask(taskId)!;
      seen.push({ taskId, type: ev.type, running: t.running, awaiting: t.awaiting_input });
      if (ev.type === "turn_end") { unsub(); resolve(); }
    });
    await startResumeTurn(task, project, "go");
    await done;

    expect(seen.every((s) => s.taskId === task.id)).toBe(true);
    const at = (type: string) => seen.find((s) => s.type === type)!;
    // Turn launch: running is already flagged when the user echo publishes.
    expect(at("user")).toMatchObject({ running: 1 });
    // Parked on a question: awaiting_input is up while still running…
    expect(at("ask")).toMatchObject({ running: 1, awaiting: 1 });
    // …and cleared the moment the last ask is answered.
    expect(at("ask_answered")).toMatchObject({ running: 1, awaiting: 0 });
    // Turn over: the row settled (running off, awaiting the user) BEFORE turn_end.
    expect(at("turn_end")).toMatchObject({ running: 0, awaiting: 1 });
  });
});

describe("queue drain re-reads the project (no stale snapshot)", () => {
  it("runs a dequeued follow-up against the project as it stands at drain time, not turn start", async () => {
    const project = createProject({ name: "DrainFresh", context: "old context", branch: "main" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    // Park a follow-up so the runner drains it as the very next turn.
    addPendingMessage(task.id, task.generation, "follow-up");

    const projectsSeen: { context: string; branch: string }[] = [];
    runTurnMock.mockImplementation(async function* (_task: unknown, proj: { context: string; branch: string }) {
      projectsSeen.push({ context: proj.context, branch: proj.branch });
      // Mid-first-turn, the project's base branch + context change under us.
      if (projectsSeen.length === 1) {
        updateProject(project.id, { branch: "release", context: "new context" });
      }
      yield { type: "session", sessionId: `s-${projectsSeen.length}` } as StreamEvent;
      yield { type: "done", sessionId: `s-${projectsSeen.length}` } as StreamEvent;
    });

    // collectEvents resolves on the FIRST turn_end it sees. The first turn hands
    // off to the drained follow-up (running stays on, no turn_end), so this
    // resolves only once the SECOND turn ends.
    const { done } = collectEvents(task.id);
    await startResumeTurn(task, project, "go");
    await done;

    expect(projectsSeen).toHaveLength(2);
    // The original turn ran against the snapshot passed in; the dequeued
    // follow-up ran against a fresh read reflecting the mid-turn mutation.
    expect(projectsSeen[0]).toEqual({ context: "old context", branch: "main" });
    expect(projectsSeen[1]).toEqual({ context: "new context", branch: "release" });
  });

  it("settles the task without crashing when the project is deleted mid-turn", async () => {
    const project = createProject({ name: "DrainDeleted" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    addPendingMessage(task.id, task.generation, "follow-up");

    let calls = 0;
    runTurnMock.mockImplementation(async function* () {
      calls++;
      yield { type: "session", sessionId: "s1" } as StreamEvent;
      // The project (and, by FK cascade, this task + its queue) is deleted while
      // the turn is live. The drain must not crash trying to resume.
      deleteProject(project.id);
      yield { type: "done", sessionId: "s1" } as StreamEvent;
    });

    const { events, done } = collectEvents(task.id);
    await startResumeTurn(task, project, "go");
    await done;

    // The runner still closed the turn out (turn_end fired) and did not launch a
    // second turn against a vanished project.
    expect(calls).toBe(1);
    expect(events.map((e) => e.type).slice(-1)).toEqual(["turn_end"]);
    expect(getTask(task.id)).toBeUndefined();
  });
});

describe("codex driver contract through the runner", () => {
  it("normalizes a real codex turn (mocked CLI) into the same runner behavior as any driver", async () => {
    const project = createProject({ name: "CodexContract" });
    updateProject(project.id, { default_agent: "codex" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    // The task runs the real codex driver — not the fallback.
    expect(task.agent).toBe("codex");
    expect(getDriver(task.agent).id).toBe("codex");

    codexRun.events = loadCodexFixture("command-file-message.jsonl");

    const { events, done } = collectEvents(task.id);
    await startResumeTurn(task, project, "go");
    await done;

    // The opaque codex thread id is persisted verbatim into session_id (the same
    // column a Claude session id lands in) and the task settles like any turn.
    const after = getTask(task.id)!;
    expect(after).toMatchObject({
      started: 1,
      status: "in_progress",
      running: 0,
      awaiting_input: 1,
      session_id: "019f3ecf-fed2-7ba3-b46e-dc6097412033",
    });

    // Session row recorded + closed with the driver's opaque id.
    const sessions = listProjectSessions(project.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].claude_session_id).toBe("019f3ecf-fed2-7ba3-b46e-dc6097412033");
    expect(sessions[0].ended_at).not.toBeNull();

    // Token usage persisted from turn.completed, with cost_usd ESTIMATED from
    // the fixture's token counts at the default model's published API prices
    // ((39612−30848)×$1.25 + 30848×$0.125 + 119×$10, per 1M) — this is what
    // populates the task cost chip and Insights for Codex tasks.
    const taskUsage = getTaskUsage(task.id)!;
    expect(taskUsage).toMatchObject({ turns: 1 });
    expect(taskUsage.total_tokens).toBeGreaterThan(0);
    expect(taskUsage.cost_usd).toBeCloseTo(0.016001, 6);

    // The driver reports the model it resolved (task.model null → the CLI
    // default), persisted for the badge and the Insights provider panel.
    expect(after.resolved_model).toBe("gpt-5.1-codex-max");

    // Transcript: user echo, the two agent messages, and the command tool call
    // merged with its result — all persisted rows, agent-agnostic.
    const msgs = listMessages(task.id);
    expect(msgs[0].content).toBe("go");
    expect(msgs.some((m) => m.role === "assistant" && m.content.includes("echo hi"))).toBe(true);
    expect(msgs.some((m) => m.role === "assistant" && m.content === "DONE")).toBe(true);
    const toolRow = msgs.find((m) => m.role === "tool");
    expect(toolRow).toBeTruthy();
    expect((JSON.parse(toolRow!.content) as ToolData).result).toContain("hi");

    // Publish contract closes with done + turn_end, same as the Claude path.
    expect(events.map((e) => e.type).slice(-2)).toEqual(["done", "turn_end"]);
    expect(events.some((e) => e.type === "session")).toBe(true);
  });
});
