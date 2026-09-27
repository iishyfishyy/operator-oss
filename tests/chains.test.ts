import { describe, it, expect, beforeEach, vi } from "vitest";

// Auto-advance chains end to end: a scripted fake driver runs through the REAL
// runner, the real turn-end safety checks (lib/chains.ts), the real
// finishChainStep commit + next-step launch (lib/autoStart.ts), and real git
// worktrees. The fake plays the agent: it writes a file in its worktree and
// (optionally) calls complete_step through the same shared logic the MCP
// tool and the bridge endpoint use.
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown) => runTurnMock(task, project, userText, ac),
  },
}));

import fs from "node:fs";
import path from "node:path";
import {
  createProject,
  createTask,
  getTask,
  setTaskDeps,
  updateTask,
  acceptSuggestedBatch,
  addPendingMessage,
  getChain,
  listTasks,
  deleteTask,
  listMessages,
} from "@/lib/store";
import { getDb } from "@/lib/db";
import { startResumeTurn } from "@/lib/runner";
import { ensureWorktree, taskDiff } from "@/lib/git";
import { abortTurn, hasTurn } from "@/lib/abort";
import { readyAutoStartDependents } from "@/lib/autoStart";
import { worktreeBaseFor, recordStepComplete, chainAdvanceBlocker, isAutoAdvanceTask } from "@/lib/chains";
import { depBlocks } from "@/lib/chainRules";
import { buildProjectContext, describeToolUse } from "@/lib/agents/shared";
import { COMPLETE_STEP } from "@/lib/agentToolDefs.mjs";
import { blockerTitles } from "@/app/orchestrator/format";
import { planChainDeps } from "@/app/orchestrator/suggestions";
import type { TaskRow } from "@/app/orchestrator/types";
import type { Project, StreamEvent, Task } from "@/lib/types";
import { git, makeRepo } from "./helpers";

type Behavior = "complete" | "silent" | "error" | "stop" | "clear" | "ask" | "queue";

// What the fake agent does on each turn, per task id (default: complete).
const behavior = new Map<string, Behavior[]>();

function agentTurn(task: Task): AsyncGenerator<StreamEvent> {
  const plan = behavior.get(task.id);
  const b: Behavior = plan?.length ? plan.shift()! : "complete";
  return (async function* () {
    yield { type: "session", sessionId: `s-${task.id}` } as StreamEvent;
    if (task.worktree_path) fs.writeFileSync(path.join(task.worktree_path, `${task.title}.txt`), `${task.title} work\n`);
    if (b !== "silent") recordStepComplete(task.id, `${task.title} is finished`);
    if (b === "error") yield { type: "error", content: "Run ended: error_during_execution" } as StreamEvent;
    if (b === "stop") abortTurn(task.id);
    // What the /clear route does to the row mid-turn: a fresh generation, reset.
    if (b === "clear") updateTask(task.id, { generation: task.generation + 1, session_id: null, started: 0, running: 0 });
    if (b === "ask") yield { type: "ask", id: `ask-${task.id}`, questions: [{ question: "Which?", header: "Q", options: [{ label: "A" }, { label: "B" }] }] } as StreamEvent;
    if (b === "queue") addPendingMessage(task.id, task.generation, "one more thing");
    yield { type: "assistant", content: `${task.title}: done` } as StreamEvent;
    yield { type: "done", sessionId: `s-${task.id}` } as StreamEvent;
  })();
}

beforeEach(() => {
  runTurnMock.mockReset();
  runTurnMock.mockImplementation((task: Task) => agentTurn(task));
  behavior.clear();
});

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Every turn (and every detached chain hand-off) for these tasks has settled. */
async function settled(ids: string[]): Promise<void> {
  // Give the detached finishChainStep (dynamic import + git) a chance to run
  // before checking: it starts after turn_end, while nothing is running.
  for (let i = 0; i < 3; i++) {
    await waitFor(() => ids.every((id) => !hasTurn(id) && !getTask(id)?.running));
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** A real repo + an auto-advance chain of `titles`, accepted as the composer does it. */
async function makeAutoChain(titles: string[]) {
  const repo = await makeRepo();
  const project = createProject({ name: `Chain ${titles.join("")}`, repo_path: repo, branch: "main" });
  const tasks = titles.map((title) => createTask({ project_id: project.id, title, description: `do ${title}`, suggested: true }));
  const ids = tasks.map((t) => t.id);
  const { link } = planChainDeps(tasks as unknown as TaskRow[], ids, ids, "auto");
  for (const e of link) setTaskDeps(e.id, e.depends_on);
  acceptSuggestedBatch(ids, true, false, "auto_review");
  const mainTip = await git(repo, "rev-parse", "main");
  return { repo, project, ids, mainTip };
}

/** Start the head the way the POST /messages route does (worktree first, then the turn). */
async function startHead(project: Project, id: string): Promise<void> {
  const task = getTask(id)!;
  const wt = (await ensureWorktree(project.repo_path, id, worktreeBaseFor(task, project)))!;
  updateTask(id, { worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha });
  await startResumeTurn(getTask(id)!, project, "go");
}

describe("chain model", () => {
  it("accepting with chain_mode creates the chain row and stamps members in order", async () => {
    const { project, ids } = await makeAutoChain(["A", "B", "C"]);
    const [a, b, c] = ids.map((id) => getTask(id)!);
    expect(a.chain_id).toBeTruthy();
    expect(new Set([a.chain_id, b.chain_id, c.chain_id]).size).toBe(1);
    expect([a.chain_pos, b.chain_pos, c.chain_pos]).toEqual([0, 1, 2]);
    expect([a.auto_start, b.auto_start, c.auto_start]).toEqual([0, 1, 1]);
    expect(getChain(a.chain_id!)).toMatchObject({ project_id: project.id, mode: "auto_review", base_branch: "main" });
    expect(listTasks(project.id).find((t) => t.id === a.id)!.chain_mode).toBe("auto_review");
  });

  it("hard-deletes: the last step's delete drops the chain; a chain delete cascades its steps", async () => {
    const one = await makeAutoChain(["A"]);
    const chainId = getTask(one.ids[0])!.chain_id!;
    deleteTask(one.ids[0]);
    expect(getChain(chainId)).toBeUndefined();

    const two = await makeAutoChain(["A", "B"]);
    const chain2 = getTask(two.ids[0])!.chain_id!;
    getDb().prepare("DELETE FROM chains WHERE id = ?").run(chain2);
    expect(two.ids.map((id) => getTask(id))).toEqual([undefined, undefined]);
  });
});

describe("complete_step tool", () => {
  it("is defined once, shared by the MCP server and the bridge", () => {
    expect(COMPLETE_STEP.name).toBe("complete_step");
    expect(COMPLETE_STEP.params.summary).toBeTruthy();
    expect(describeToolUse("mcp__orchestrator__complete_step", { summary: "x" }).title).toMatch(/step complete/i);
  });

  it("saves the summary on a chain step and refuses anything outside an auto-advance chain", async () => {
    const { ids } = await makeAutoChain(["A", "B"]);
    const r = recordStepComplete(ids[0], "  built the thing  ");
    expect(r.ok).toBe(true);
    expect(getTask(ids[0])!.step_summary).toBe("built the thing");
    expect(getTask(ids[0])!.step_completed_at).toBeGreaterThan(0);

    const project = createProject({ name: "Plain" });
    const plain = createTask({ project_id: project.id, title: "Solo" });
    const refused = recordStepComplete(plain.id, "done");
    expect(refused.ok).toBe(false);
    expect(getTask(plain.id)!.step_completed_at).toBe(0);
  });

  it("is only mentioned in the system prompt for an auto-advance chain step", async () => {
    const { project, ids } = await makeAutoChain(["A", "B"]);
    expect(buildProjectContext(project, getTask(ids[1])!)).toContain("complete_step");
    const plain = createTask({ project_id: project.id, title: "Solo" });
    expect(buildProjectContext(project, plain)).not.toContain("complete_step");
  });
});

describe("chainAdvanceBlocker (the turn-end safety checks)", () => {
  async function base() {
    const { ids } = await makeAutoChain(["A", "B"]);
    const startedAt = Date.now() - 1000;
    updateTask(ids[0], { status: "in_progress", step_completed_at: Date.now() });
    const state = {
      task: getTask(ids[0]),
      generation: 1,
      turnStartedAt: startedAt,
      turnError: null as string | null,
      stopped: false,
      superseded: false,
      openAsks: 0,
      pendingAsk: false,
      pendingMessages: 0,
    };
    return { ids, state };
  }

  it("allows a clean, completed turn", async () => {
    const { state } = await base();
    expect(chainAdvanceBlocker(state)).toBeNull();
  });

  it("pauses on each unmet condition", async () => {
    const { ids, state } = await base();
    const t = state.task!;
    expect(chainAdvanceBlocker({ ...state, task: { ...t, step_completed_at: 0 } })).toMatch(/complete_step/);
    expect(chainAdvanceBlocker({ ...state, task: { ...t, step_completed_at: state.turnStartedAt - 1 } })).toMatch(/complete_step/);
    expect(chainAdvanceBlocker({ ...state, turnError: "prompt is too long" })).toMatch(/failed/);
    expect(chainAdvanceBlocker({ ...state, stopped: true })).toMatch(/stopped/);
    expect(chainAdvanceBlocker({ ...state, generation: 0 })).toMatch(/generation/);
    expect(chainAdvanceBlocker({ ...state, superseded: true })).toMatch(/superseded/);
    expect(chainAdvanceBlocker({ ...state, openAsks: 1 })).toMatch(/question/);
    expect(chainAdvanceBlocker({ ...state, pendingAsk: true })).toMatch(/question/);
    expect(chainAdvanceBlocker({ ...state, pendingMessages: 2 })).toMatch(/queued/);
    expect(chainAdvanceBlocker({ ...state, task: undefined })).toMatch(/deleted/);
    // Not in an auto-advance chain at all.
    const project = createProject({ name: "NoChain" });
    const plain = createTask({ project_id: project.id, title: "Solo" });
    expect(chainAdvanceBlocker({ ...state, task: { ...plain, step_completed_at: Date.now() } })).toMatch(/not an auto-advance/);
    expect(ids.length).toBe(2);
  });
});

describe("auto-advance through the runner (stacked worktrees)", () => {
  it("commits a finished step on its own branch, moves it to in_review, and stacks the next step on it", async () => {
    const { repo, project, ids, mainTip } = await makeAutoChain(["A", "B", "C"]);
    const [aId, bId, cId] = ids;
    await startHead(project, aId);
    await waitFor(() => getTask(cId)!.status === "in_review");
    await settled(ids);

    const [a, b, c] = ids.map((id) => getTask(id)!);
    for (const t of [a, b, c]) {
      expect(t.status).toBe("in_review");
      expect(t.awaiting_input).toBe(0);
    }
    expect(a.step_summary).toBe("A is finished");

    // The base branch is never touched.
    expect(await git(repo, "rev-parse", "main")).toBe(mainTip);

    // Each step's worktree branched from the previous step's branch, and its
    // base_sha is the previous step's last commit (the committed step).
    const aTip = await git(repo, "rev-parse", a.work_branch);
    const bTip = await git(repo, "rev-parse", b.work_branch);
    expect(a.base_sha).toBe(mainTip);
    expect(b.base_sha).toBe(aTip);
    expect(c.base_sha).toBe(bTip);
    expect(await git(repo, "log", "-1", "--format=%B", a.work_branch)).toContain("A is finished");
    // B sees A's work; C sees both.
    expect(fs.existsSync(path.join(b.worktree_path, "A.txt"))).toBe(true);
    expect(fs.existsSync(path.join(c.worktree_path, "A.txt"))).toBe(true);
    expect(fs.existsSync(path.join(c.worktree_path, "B.txt"))).toBe(true);

    // Per-step diff: each step shows only its own changes.
    const files = async (t: Task) => (await taskDiff(repo, t.worktree_path, t.base_sha, project.branch)).files.map((f) => f.path).sort();
    expect(await files(a)).toEqual(["A.txt"]);
    expect(await files(b)).toEqual(["B.txt"]);
    expect(await files(c)).toEqual(["C.txt"]);

    // The next step was launched with the auto-advance note.
    expect(listMessages(bId).some((m) => m.role === "system" && m.content.includes("Auto-advanced"))).toBe(true);
  });

  const pauses: [string, Behavior][] = [
    ["complete_step was never called", "silent"],
    ["the turn failed", "error"],
    ["the user pressed Stop", "stop"],
    ["an ask is still open", "ask"],
  ];
  for (const [why, b] of pauses) {
    it(`pauses (awaiting_input stays set, next step waits) when ${why}`, async () => {
      const { project, ids } = await makeAutoChain(["A", "B"]);
      behavior.set(ids[0], [b]);
      await startHead(project, ids[0]);
      await settled(ids);
      const a = getTask(ids[0])!;
      expect(a.status).toBe("in_progress");
      expect(a.awaiting_input).toBe(1);
      expect(getTask(ids[1])!.started).toBe(0);
      expect(getTask(ids[1])!.status).toBe("not_started");
    });
  }

  it("pauses when the generation changed mid-turn (/clear)", async () => {
    const { project, ids } = await makeAutoChain(["A", "B"]);
    behavior.set(ids[0], ["clear"]);
    await startHead(project, ids[0]);
    await settled(ids);
    expect(getTask(ids[0])!.status).not.toBe("in_review");
    expect(getTask(ids[1])!.started).toBe(0);
  });

  it("pauses when a follow-up is queued — and a stale complete_step doesn't count for the next turn", async () => {
    const { project, ids } = await makeAutoChain(["A", "B"]);
    // Turn 1 completes but leaves a queued message; turn 2 (the dequeued
    // message) doesn't call complete_step, so the step still isn't finished.
    behavior.set(ids[0], ["queue", "silent"]);
    await startHead(project, ids[0]);
    await waitFor(() => runTurnMock.mock.calls.length >= 2);
    await settled(ids);
    const a = getTask(ids[0])!;
    expect(a.status).toBe("in_progress");
    expect(a.awaiting_input).toBe(1);
    expect(getTask(ids[1])!.started).toBe(0);
  });

  it("a task outside any chain still ends every turn awaiting input", async () => {
    const repo = await makeRepo();
    const project = createProject({ name: "Plain chain-less", repo_path: repo, branch: "main" });
    const t = createTask({ project_id: project.id, title: "Solo" });
    await startHead(project, t.id);
    await settled([t.id]);
    expect(getTask(t.id)!.status).toBe("in_progress");
    expect(getTask(t.id)!.awaiting_input).toBe(1);
  });
});

describe("in_review unblocks only the same auto-advance chain", () => {
  it("server: readyAutoStartDependents", async () => {
    const { project, ids } = await makeAutoChain(["A", "B"]);
    const other = await makeAutoChain(["X", "Y"]);
    const [aId, bId] = ids;
    // A plain (chain-less) auto-start task, and a step of a DIFFERENT chain, both blocked by A.
    const plain = createTask({ project_id: project.id, title: "Plain" });
    setTaskDeps(plain.id, [aId]);
    updateTask(plain.id, { auto_start: 1 });
    const foreign = getTask(other.ids[1])!;
    // (cross-project deps are dropped by setTaskDeps, so wire the edge directly)
    getDb().prepare("INSERT INTO task_dependencies (task_id, depends_on_id, created_at) VALUES (?, ?, ?)").run(foreign.id, aId, Date.now());

    updateTask(aId, { status: "in_review" });
    expect(readyAutoStartDependents(aId).map((t) => t.id)).toEqual([bId]);
    // done still unblocks everyone.
    updateTask(aId, { status: "done" });
    expect(readyAutoStartDependents(aId).map((t) => t.id).sort()).toEqual([bId, plain.id].sort());
  });

  it("client: blockerTitles agrees", async () => {
    const { project, ids } = await makeAutoChain(["A", "B"]);
    updateTask(ids[0], { status: "in_review" });
    const plain = createTask({ project_id: project.id, title: "Plain" });
    setTaskDeps(plain.id, [ids[0]]);
    const rows = listTasks(project.id) as unknown as TaskRow[];
    const byId = new Map(rows.map((t) => [t.id, t]));
    expect(blockerTitles(byId.get(ids[1])!, byId)).toEqual([]);
    expect(blockerTitles(byId.get(plain.id)!, byId)).toEqual(["A"]);
  });

  it("the shared rule", () => {
    const auto = { chain_id: "c1", chain_mode: "auto_review" };
    expect(depBlocks({ status: "in_review", chain_id: "c1" }, auto)).toBe(false);
    expect(depBlocks({ status: "in_review", chain_id: "c2" }, auto)).toBe(true);
    expect(depBlocks({ status: "in_review", chain_id: "c1" }, { chain_id: "c1", chain_mode: "other" })).toBe(true);
    expect(depBlocks({ status: "in_review", chain_id: null }, { chain_id: null })).toBe(true);
    expect(depBlocks({ status: "done" }, {})).toBe(false);
    expect(depBlocks({ status: "cancelled" }, {})).toBe(false);
    expect(depBlocks({ status: "in_progress", chain_id: "c1" }, auto)).toBe(true);
  });
});

describe("worktreeBaseFor", () => {
  it("stacks a chain step on its predecessor's branch; everything else uses the project branch", async () => {
    const { project, ids } = await makeAutoChain(["A", "B"]);
    expect(worktreeBaseFor(getTask(ids[0])!, project)).toBe("main");
    // Predecessor has no branch yet (never started / non-git fallback) → base branch.
    expect(worktreeBaseFor(getTask(ids[1])!, project)).toBe("main");
    updateTask(ids[0], { work_branch: "orch/a" });
    expect(worktreeBaseFor(getTask(ids[1])!, project)).toBe("orch/a");
    expect(isAutoAdvanceTask(getTask(ids[1])!)).toBe(true);
  });
});

describe("chain composer deps planning", () => {
  const row = (id: string, depends_on: string[] = []) => ({ id, depends_on }) as unknown as TaskRow;
  it("auto links each task to the one before it, like done", () => {
    const tasks = [row("a"), row("b"), row("c")];
    const auto = planChainDeps(tasks, ["a", "b", "c"], ["c", "a", "b"], "auto");
    expect(auto).toEqual(planChainDeps(tasks, ["a", "b", "c"], ["c", "a", "b"], "done"));
    expect(auto.link).toEqual([{ id: "a", depends_on: ["c"] }, { id: "b", depends_on: ["a"] }]);
  });
  it("now leaves them unlinked", () => {
    const tasks = [row("a"), row("b", ["a"])];
    expect(planChainDeps(tasks, ["a", "b"], ["a", "b"], "now")).toEqual({ clear: [{ id: "b", depends_on: [] }], link: [] });
  });
});
