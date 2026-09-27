import { describe, it, expect, beforeEach, vi } from "vitest";

// Chain review phase 3 (lib/chainActions.ts): Send back, Discard from step k,
// pause/resume re-advancing, the awaiting-review count, and the edge cases
// (a step deleted mid-chain, the base branch moving, /clear on a finished
// step). A scripted fake driver runs through the REAL runner, finishChainStep
// and real git worktrees, like tests/chains.test.ts.
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
  createChain,
  getTask,
  setTaskDeps,
  updateTask,
  acceptSuggestedBatch,
  listChainFixups,
  listNeedsYou,
  listProjects,
  countAwaiting,
  deleteTask,
  listTasks,
} from "@/lib/store";
import { startResumeTurn } from "@/lib/runner";
import { ensureWorktree, commitWorktree } from "@/lib/git";
import { hasTurn } from "@/lib/abort";
import { recordStepComplete, worktreeBaseFor, buildFixupPrompt, pauseReason } from "@/lib/chains";
import { CONTINUE_STEP_PROMPT } from "@/lib/chainRules";
import { sendBackChain, discardChainFrom, rebaseChainStack } from "@/lib/chainActions";
import { getChainView, mergeChain, sendBackBlocker, ChainError } from "@/lib/chainMerge";
import { chainsForReview, chainAwaitsReview, countChainsAwaitingReview } from "@/app/orchestrator/chains";
import { planChainDeps } from "@/app/orchestrator/suggestions";
import { PATCH as patchTask, DELETE as deleteTaskRoute } from "@/app/api/tasks/[id]/route";
import { POST as clearRoute } from "@/app/api/tasks/[id]/clear/route";
import { GET as eventsRoute } from "@/app/api/events/route";
import { publishGlobal } from "@/lib/events";
import type { TaskRow } from "@/app/orchestrator/types";
import type { Project, StreamEvent, Task } from "@/lib/types";
import { git, makeRepo, commitFile, uid } from "./helpers";

type Behavior = "complete" | "silent" | "ask";
const behavior = new Map<string, Behavior[]>();
const turns = new Map<string, number>();

// The fake agent: appends a line to its own file each turn (so fix-ups have a
// diff), then calls complete_step unless told not to.
function agentTurn(task: Task): AsyncGenerator<StreamEvent> {
  const plan = behavior.get(task.id);
  const b: Behavior = plan?.length ? plan.shift()! : "complete";
  const n = (turns.get(task.id) ?? 0) + 1;
  turns.set(task.id, n);
  return (async function* () {
    yield { type: "session", sessionId: `s-${task.id}` } as StreamEvent;
    if (task.worktree_path) fs.appendFileSync(path.join(task.worktree_path, `${task.title}.txt`), `${task.title} turn ${n}\n`);
    if (b === "complete") recordStepComplete(task.id, `${task.title} turn ${n} finished`);
    if (b === "ask") yield { type: "ask", id: `ask-${task.id}-${n}`, questions: [{ question: "Which?", header: "Q", options: [{ label: "A" }, { label: "B" }] }] } as StreamEvent;
    yield { type: "assistant", content: `${task.title}: turn ${n}` } as StreamEvent;
    yield { type: "done", sessionId: `s-${task.id}` } as StreamEvent;
  })();
}

beforeEach(() => {
  runTurnMock.mockReset();
  runTurnMock.mockImplementation((task: Task) => agentTurn(task));
  behavior.clear();
  turns.clear();
});

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function settled(ids: string[]): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await waitFor(() => ids.every((id) => !getTask(id) || (!hasTurn(id) && !getTask(id)?.running)));
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function makeAutoChain(titles: string[]) {
  const repo = await makeRepo();
  const project = createProject({ name: `Review ${uid()}`, repo_path: repo, branch: "main" });
  const tasks = titles.map((title) => createTask({ project_id: project.id, title, description: `do ${title}`, suggested: true }));
  const ids = tasks.map((t) => t.id);
  const { link } = planChainDeps(tasks as unknown as TaskRow[], ids, ids, "auto");
  for (const e of link) setTaskDeps(e.id, e.depends_on);
  acceptSuggestedBatch(ids, true, false, "auto_review");
  return { repo, project, ids, chainId: getTask(ids[0])!.chain_id! };
}

async function startHead(project: Project, id: string): Promise<void> {
  const task = getTask(id)!;
  const wt = (await ensureWorktree(project.repo_path, id, worktreeBaseFor(task, project)))!;
  updateTask(id, { worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha });
  await startResumeTurn(getTask(id)!, project, "go");
}

/** Run a whole chain to review through the real runner. */
async function chainInReview(titles: string[]) {
  const c = await makeAutoChain(titles);
  await startHead(c.project, c.ids[0]);
  await waitFor(() => getTask(c.ids[c.ids.length - 1])!.status === "in_review");
  await settled(c.ids);
  return c;
}

/** A repo + a chain of committed, In-review stacked steps built directly (no turns). Step i writes step{i+1}.txt. */
async function makeStackedChain(n: number) {
  const repo = await makeRepo();
  const project = createProject({ name: `Stack ${uid()}`, repo_path: repo, branch: "main" });
  const ids = Array.from({ length: n }, (_, i) => createTask({ project_id: project.id, title: `Step ${i + 1}` }).id);
  const chain = createChain(project.id, ids, "auto_review", "main");
  let base = "main";
  for (let i = 0; i < n; i++) {
    const wt = (await ensureWorktree(repo, ids[i], base))!;
    fs.writeFileSync(path.join(wt.path, `step${i + 1}.txt`), `step ${i + 1}\n`);
    await commitWorktree(wt.path, `step ${i + 1}`);
    updateTask(ids[i], { worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha, started: 1, status: "in_review", step_summary: `did step ${i + 1}` });
    base = wt.branch;
  }
  return { repo, project, chainId: chain.id, ids };
}

const onBranch = async (repo: string, ref: string, file: string) => git(repo, "cat-file", "-e", `${ref}:${file}`).then(() => true).catch(() => false);
const branchExists = async (repo: string, branch: string) => git(repo, "rev-parse", "--verify", "-q", branch).then(() => true).catch(() => false);
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("Send back", () => {
  it("runs the feedback as a fix-up turn on the LAST step, naming the step it's about, then the chain is back in review", async () => {
    const { repo, ids, chainId } = await chainInReview(["A", "B", "C"]);
    const [aId, , cId] = ids;
    const cTipBefore = await git(repo, "rev-parse", getTask(cId)!.work_branch);
    runTurnMock.mockClear();

    const out = await sendBackChain(chainId, "A's error message is unclear", aId);
    expect(out.taskId).toBe(cId);
    await waitFor(() => getTask(cId)!.status === "in_review" && !getTask(cId)!.running);
    await settled(ids);

    // Routed through the runner on step C, with the prompt naming step 1 and its summary.
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    const [task, , prompt] = runTurnMock.mock.calls[0] as [Task, Project, string];
    expect(task.id).toBe(cId);
    expect(prompt).toContain(`step 1, "A"`);
    expect(prompt).toContain("A turn 1 finished");
    expect(prompt).toContain("A's error message is unclear");
    expect(prompt).toContain("complete_step");

    // The fix-up has its own record; the step keeps its original summary.
    const [f] = listChainFixups(chainId);
    expect(f).toMatchObject({ task_id: cId, about_task_id: aId, about_pos: 0, start_sha: cTipBefore, summary: "C turn 2 finished" });
    expect(f.completed_at).toBeGreaterThan(0);
    expect(getTask(cId)!.step_summary).toBe("C turn 1 finished");

    // Committed as its own commit on C's branch; nothing else moved.
    const c = getTask(cId)!;
    expect(await git(repo, "log", "-1", "--format=%s", c.work_branch)).toMatch(/^Fix-up: A's error message/);
    expect(ids.map((id) => getTask(id)!.status)).toEqual(["in_review", "in_review", "in_review"]);

    // The review shows it as a trailing fix-up entry with its own lines.
    const view = (await getChainView(chainId))!;
    expect(view.fixups).toHaveLength(1);
    expect(view.fixups[0]).toMatchObject({ taskId: cId, stepPos: 2, aboutPos: 0, aboutTitle: "A", state: "done", additions: 1, deletions: 0 });
    expect(view.sendBackBlocker).toBeNull();

    // And the whole chain, fix-up included, lands with one merge.
    const merged = await mergeChain(chainId);
    expect(merged.ok).toBe(true);
    expect(await git(repo, "show", "main:C.txt")).toContain("C turn 2");
  });

  it("a fix-up that ends without complete_step pauses; setting the step back to In review finishes it", async () => {
    const { ids, chainId } = await chainInReview(["A", "B"]);
    const bId = ids[1];
    behavior.set(bId, ["silent"]);
    await sendBackChain(chainId, "tweak it");
    await settled(ids);

    const b = getTask(bId)!;
    expect(b.status).toBe("in_progress");
    expect(b.awaiting_input).toBe(1);
    expect(b.step_pause).toBe("Ended without calling complete_step");
    const view = (await getChainView(chainId))!;
    expect(view.fixups[0].state).toBe("paused");
    // A second send back waits for the open one.
    expect(view.sendBackBlocker).toMatch(/fix-up is still open/);
    await expect(sendBackChain(chainId, "again")).rejects.toThrow(/fix-up is still open/);

    // "Or the user": the user sets the step back to In review.
    await patchTask(new Request("http://t", { method: "PATCH", body: JSON.stringify({ status: "in_review" }) }), params(bId));
    expect(getTask(bId)!.status).toBe("in_review");
    expect(getTask(bId)!.step_pause).toBe("");
    expect(listChainFixups(chainId)[0].completed_at).toBeGreaterThan(0);
  });

  it("refuses empty feedback, a running step, an unfinished chain, and a step from another chain", async () => {
    const { ids, chainId } = await chainInReview(["A", "B"]);
    await expect(sendBackChain(chainId, "   ")).rejects.toBeInstanceOf(ChainError);
    await expect(sendBackChain(chainId, "x", "not-a-step")).rejects.toThrow(/isn't a step/);

    const steps = ids.map((id) => getTask(id)!);
    expect(sendBackBlocker(steps, [], (t) => t.id === ids[0])).toMatch(/running/);
    expect(sendBackBlocker([steps[0], { ...steps[1], status: "not_started" }], [])).toMatch(/hasn't run yet/);
    expect(sendBackBlocker(steps.map((s) => ({ ...s, status: "done" as const, merged_at: 1 })), [])).toMatch(/already merged/);
    expect(sendBackBlocker(steps, [])).toBeNull();
  });

  it("the fix-up prompt covers the whole chain when no step is named", () => {
    const p = buildFixupPrompt({
      feedback: "tests are flaky",
      steps: [{ chain_pos: 0, title: "A", step_summary: "" }, { chain_pos: 1, title: "B", step_summary: "" }],
      last: { chain_pos: 1, title: "B" },
    });
    expect(p).toContain("about the chain as a whole");
    expect(p).toContain("1. A");
    expect(p).toContain("tests are flaky");
  });
});

describe("Discard from step k", () => {
  it("hard-deletes steps k..n with their worktrees and branches; earlier steps stay mergeable", async () => {
    const { repo, chainId, ids } = await makeStackedChain(3);
    const doomed = ids.slice(1).map((id) => getTask(id)!);

    const out = await discardChainFrom(chainId, ids[1]);
    expect(out.deleted.sort()).toEqual(ids.slice(1).sort());
    for (const t of doomed) {
      expect(getTask(t.id)).toBeUndefined();
      expect(fs.existsSync(t.worktree_path)).toBe(false);
      expect(await branchExists(repo, t.work_branch)).toBe(false);
    }
    const view = (await getChainView(chainId))!;
    expect(view.steps.map((s) => s.id)).toEqual([ids[0]]);
    expect(view.steps[0].mergeBlocker).toBeNull();

    const merged = await mergeChain(chainId);
    expect(merged.ok).toBe(true);
    expect(await onBranch(repo, "main", "step1.txt")).toBe(true);
    expect(await onBranch(repo, "main", "step2.txt")).toBe(false);
  });

  it("refuses to discard a range holding a merged step", async () => {
    const { chainId, ids } = await makeStackedChain(2);
    expect((await mergeChain(chainId, ids[0])).ok).toBe(true);
    await expect(discardChainFrom(chainId, ids[0])).rejects.toThrow(/already merged/);
    // Discarding only the unmerged tail is fine.
    expect((await discardChainFrom(chainId, ids[1])).deleted).toEqual([ids[1]]);
  });
});

describe("pause / resume re-advances the chain", () => {
  it("a step paused for a missing complete_step records why, and Continue picks auto-advance back up", async () => {
    const { project, ids } = await makeAutoChain(["A", "B"]);
    behavior.set(ids[0], ["silent"]);
    await startHead(project, ids[0]);
    await settled(ids);
    const a = getTask(ids[0])!;
    expect(a.awaiting_input).toBe(1);
    expect(a.step_pause).toBe("Ended without calling complete_step");
    expect(getTask(ids[1])!.started).toBe(0);

    // The chain card surfaces it with the reason.
    const [card] = chainsForReview(listTasks(project.id) as unknown as TaskRow[], new Set());
    expect(card.pausedStep?.id).toBe(ids[0]);
    expect(card.pauseReason).toBe("Ended without calling complete_step");

    // Continue: a resume turn that calls complete_step advances the chain.
    await startResumeTurn(getTask(ids[0])!, project, CONTINUE_STEP_PROMPT);
    await waitFor(() => getTask(ids[1])!.status === "in_review");
    await settled(ids);
    expect(getTask(ids[0])!.status).toBe("in_review");
    expect(getTask(ids[0])!.step_pause).toBe("");
    expect(getTask(ids[1])!.base_sha).toBe(await git(project.repo_path, "rev-parse", getTask(ids[0])!.work_branch));
  });

  it("an open question pauses with its reason, and answering (a resume turn) re-advances", async () => {
    const { project, ids } = await makeAutoChain(["A", "B"]);
    behavior.set(ids[0], ["ask"]);
    await startHead(project, ids[0]);
    await settled(ids);
    expect(getTask(ids[0])!.step_pause).toBe("Waiting on your answer");
    await startResumeTurn(getTask(ids[0])!, project, "A");
    await waitFor(() => getTask(ids[1])!.status === "in_review");
    await settled(ids);
    expect(getTask(ids[0])!.status).toBe("in_review");
  });

  it("pauseReason words only the real pauses", () => {
    expect(pauseReason("turn failed")).toBe("The turn hit an error");
    expect(pauseReason("stopped")).toBe("Stopped");
    expect(pauseReason("queued messages")).toBe("");
    expect(pauseReason(null)).toBe("");
  });
});

describe("a chain waiting for review counts in 'N need you'", () => {
  it("counts once per finished chain on the badge, the pill's dropdown, and the /api/events payload", async () => {
    const { project, chainId, ids } = await makeStackedChain(3);
    expect(countAwaiting(project.id)).toBe(1);
    expect(listProjects().find((p) => p.id === project.id)!.awaiting_count).toBe(1);
    const rows = listNeedsYou().filter((r) => r.project_id === project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ chain_id: chainId, id: ids[2], title: "Review chain: Step 1" });

    // The client's live count agrees.
    const tasks = listTasks(project.id) as unknown as TaskRow[];
    expect(countChainsAwaitingReview(tasks, new Set())).toBe(1);
    expect(chainAwaitsReview(tasks, new Set([ids[1]]))).toBe(false);

    // Not while any step runs or isn't finished — a paused step counts as itself instead.
    updateTask(ids[2], { running: 1 });
    expect(countAwaiting(project.id)).toBe(0);
    updateTask(ids[2], { running: 0, status: "in_progress", awaiting_input: 1 });
    expect(countAwaiting(project.id)).toBe(1);
    expect(listNeedsYou().filter((r) => r.project_id === project.id)[0].chain_id).toBeNull();
    updateTask(ids[2], { status: "in_review", awaiting_input: 0 });

    // Sent over the global stream.
    const ac = new AbortController();
    const res = await eventsRoute(new Request("http://test/api/events", { signal: ac.signal }));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const nextData = async (): Promise<Record<string, unknown>> => {
      for (;;) {
        const idx = buf.indexOf("\n\n");
        if (idx >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (frame.startsWith("data: ")) return JSON.parse(frame.slice(6));
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream closed");
        buf += decoder.decode(value);
      }
    };
    try {
      publishGlobal(ids[2], { type: "task_updated" });
      expect(await nextData()).toMatchObject({ type: "task", taskId: ids[2], status: "in_review", step_pause: "", awaiting_count: 1 });
    } finally {
      ac.abort();
    }

    // Merged → no longer waiting.
    expect((await mergeChain(chainId)).ok).toBe(true);
    expect(countAwaiting(project.id)).toBe(0);
  });
});

describe("edge cases", () => {
  it("a step deleted mid-chain: the next step re-links to the one before and advances on top of it", async () => {
    const { project, ids } = await makeAutoChain(["A", "B", "C"]);
    behavior.set(ids[1], ["silent"]); // B pauses; C waits on it
    await startHead(project, ids[0]);
    await waitFor(() => getTask(ids[1])!.awaiting_input === 1);
    await settled(ids);
    expect(getTask(ids[2])!.started).toBe(0);

    await deleteTaskRoute(new Request("http://t", { method: "DELETE" }), params(ids[1]));
    await waitFor(() => getTask(ids[2])!.status === "in_review");
    await settled([ids[0], ids[2]]);
    const [a, c] = [getTask(ids[0])!, getTask(ids[2])!];
    expect(c.base_sha).toBe(await git(project.repo_path, "rev-parse", a.work_branch));
    expect(fs.existsSync(path.join(c.worktree_path, "B.txt"))).toBe(false);
  });

  it("a later step built on a deleted step is flagged and refused until the stack is rebased", async () => {
    const { repo, chainId, ids } = await makeStackedChain(3);
    deleteTask(ids[1]); // step 3 still stacks on step 2's commits
    const view = (await getChainView(chainId))!;
    expect(view.warnings.join()).toMatch(/step 3 .* since been deleted/);
    await expect(mergeChain(chainId)).rejects.toThrow(/since been deleted/);

    expect((await rebaseChainStack(chainId)).ok).toBe(true);
    expect((await getChainView(chainId))!.warnings).toEqual([]);
    expect((await mergeChain(chainId)).ok).toBe(true);
    expect(await onBranch(repo, "main", "step3.txt")).toBe(true);
    expect(await onBranch(repo, "main", "step2.txt")).toBe(false);
  });

  it("the base branch moving is offered as a rebase; the stack replays onto it keeping per-step diffs", async () => {
    const { repo, chainId, ids } = await makeStackedChain(2);
    const newTip = await commitFile(repo, "other.txt", "main moved\n");
    const before = (await getChainView(chainId))!;
    expect(before.baseMoved).toEqual({ behind: 1, conflicts: [] });

    const out = await rebaseChainStack(chainId);
    expect(out.ok).toBe(true);
    const [s1, s2] = ids.map((id) => getTask(id)!);
    expect(s1.base_sha).toBe(newTip);
    expect(s2.base_sha).toBe(await git(repo, "rev-parse", s1.work_branch));
    expect(fs.existsSync(path.join(s2.worktree_path, "other.txt"))).toBe(true);
    const after = (await getChainView(chainId))!;
    expect(after.baseMoved).toBeNull();
    expect(after.steps.map((s) => [s.additions, s.deletions])).toEqual([[1, 0], [1, 0]]);
  });

  it("a conflicting rebase rolls every step back and names the step", async () => {
    const { repo, chainId, ids } = await makeStackedChain(2);
    const tips = await Promise.all(ids.map((id) => git(repo, "rev-parse", getTask(id)!.work_branch)));
    await commitFile(repo, "step2.txt", "main's own step2\n");
    const out = await rebaseChainStack(chainId);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.taskId).toBe(ids[1]);
      expect(out.conflicts).toEqual(["step2.txt"]);
    }
    expect(await Promise.all(ids.map((id) => git(repo, "rev-parse", getTask(id)!.work_branch)))).toEqual(tips);
    expect(await git(getTask(ids[1])!.worktree_path, "status", "--porcelain")).toBe("");
  });

  it("refuses to rebase a stack holding a merge commit, touching nothing", async () => {
    const { repo, chainId, ids } = await makeStackedChain(2);
    // Step 2 synced with main by hand: a merge commit carrying its own edit.
    await commitFile(repo, "other.txt", "main moved\n");
    const wt = getTask(ids[1])!.worktree_path;
    await git(wt, "merge", "--no-ff", "--no-commit", "main");
    fs.writeFileSync(path.join(wt, "other.txt"), "edited inside the merge\n");
    await git(wt, "add", "-A");
    await git(wt, "commit", "-m", "sync main", "--no-verify");
    const tips = await Promise.all(ids.map((id) => git(repo, "rev-parse", getTask(id)!.work_branch)));

    await expect(rebaseChainStack(chainId)).rejects.toThrow(/step 2 .*merge commit/);
    expect(await Promise.all(ids.map((id) => git(repo, "rev-parse", getTask(id)!.work_branch)))).toEqual(tips);
    // Merging still works and keeps the edit.
    expect((await mergeChain(chainId)).ok).toBe(true);
    expect(await git(repo, "show", "main:other.txt")).toBe("edited inside the merge");
  });

  it("/clear on a finished step keeps it In review (later steps stack on it)", async () => {
    const { ids } = await makeStackedChain(2);
    updateTask(ids[0], { step_pause: "Stopped" });
    const res = await clearRoute(new Request("http://t/clear", { method: "POST" }), params(ids[0]));
    expect(res.status).toBe(200);
    const t = getTask(ids[0])!;
    expect(t.status).toBe("in_review");
    expect(t.generation).toBe(2);
    expect(t.step_pause).toBe("");
  });
});
