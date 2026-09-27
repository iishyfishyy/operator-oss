import { describe, it, expect, vi } from "vitest";

// Merged steps turn done, which can auto-start a dependent through the real
// runner — script the agent so no CLI is ever spawned.
vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    runTurn: async function* () {
      yield { type: "session", sessionId: "s-fake" };
      yield { type: "done", sessionId: "s-fake" };
    },
  },
}));

// Chain review + merge (lib/chainMerge.ts): a real repo, real stacked
// worktrees built the way finishChainStep leaves them (each step branched from
// the previous step's branch, committed, In review), then the chain merge.

import fs from "node:fs";
import path from "node:path";
import {
  createProject,
  createTask,
  createChain,
  getTask,
  updateTask,
  setTaskDeps,
  listChainSteps,
} from "@/lib/store";
import { getDb } from "@/lib/db";
import { ensureWorktree, commitWorktree, worktreeMergeStatus } from "@/lib/git";
import { registerTurn, unregisterTurn } from "@/lib/abort";
import { mergeChain, prepareChainMerge, getChainView, chainMergeBlocker, ChainError } from "@/lib/chainMerge";
import { chainsForReview, chainProgressLabel } from "@/app/orchestrator/chains";
import type { TaskRow } from "@/app/orchestrator/types";
import type { Task } from "@/lib/types";
import { git, makeRepo, commitFile, uid } from "./helpers";

/** A repo + a chain of `n` stacked, committed, In-review steps. Step i adds `i+1` lines to its own file. */
async function makeStackedChain(n: number, opts: { finished?: number } = {}) {
  const repo = await makeRepo();
  const project = createProject({ name: `Stack ${uid()}`, repo_path: repo, branch: "main" });
  const tasks = Array.from({ length: n }, (_, i) => createTask({ project_id: project.id, title: `Step ${i + 1}` }));
  const ids = tasks.map((t) => t.id);
  const chain = createChain(project.id, ids, "auto_review", "main");
  const finished = opts.finished ?? n;
  let base = "main";
  for (let i = 0; i < finished; i++) {
    const wt = (await ensureWorktree(repo, ids[i], base))!;
    const lines = Array.from({ length: i + 1 }, (_, k) => `step ${i + 1} line ${k + 1}`).join("\n") + "\n";
    fs.writeFileSync(path.join(wt.path, `step${i + 1}.txt`), lines);
    await commitWorktree(wt.path, `step ${i + 1}`);
    updateTask(ids[i], {
      worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha,
      started: 1, status: "in_review", step_summary: `did step ${i + 1}`, step_completed_at: Date.now(),
    });
    base = wt.branch;
  }
  return { repo, project, chain, ids };
}

const merges = (taskId: string) =>
  getDb().prepare("SELECT additions, deletions FROM task_merges WHERE task_id = ?").all(taskId) as { additions: number; deletions: number }[];

const onMain = async (repo: string, file: string) => git(repo, "cat-file", "-e", `main:${file}`).then(() => true).catch(() => false);

describe("merge chain", () => {
  it("lands a 3-step stack with one merge and marks every step merged + done", async () => {
    const { repo, chain, ids } = await makeStackedChain(3);
    const res = await mergeChain(chain.id);
    expect(res.ok).toBe(true);
    expect(res.targetTaskId).toBe(ids[2]);
    expect(res.mergedTaskIds).toEqual(ids);
    for (const f of ["step1.txt", "step2.txt", "step3.txt"]) expect(await onMain(repo, f)).toBe(true);
    // One merge commit on main carries the whole stack.
    expect(await git(repo, "rev-list", "--count", "--merges", "main")).toBe("1");
    for (const id of ids) {
      const t = getTask(id)!;
      expect(t.status).toBe("done");
      expect(t.merged_at).toBeGreaterThan(0);
      expect(t.awaiting_input).toBe(0);
    }
  });

  it("records one insights row per step with that step's own line counts", async () => {
    const { chain, ids } = await makeStackedChain(3);
    await mergeChain(chain.id);
    expect(ids.map(merges)).toEqual([[{ additions: 1, deletions: 0 }], [{ additions: 2, deletions: 0 }], [{ additions: 3, deletions: 0 }]]);
    // After the merge the view reads the recorded rows (the diff base moved on).
    const view = (await getChainView(chain.id))!;
    expect(view.steps.map((s) => [s.merged, s.additions])).toEqual([[true, 1], [true, 2], [true, 3]]);
    expect(view.stats).toMatchObject({ total: 3, merged: 3, finished: 0 });
  });

  it("the view lists steps in order with summaries, stats, and the default target", async () => {
    const { chain, ids } = await makeStackedChain(3, { finished: 2 });
    const view = (await getChainView(chain.id))!;
    expect(view.baseBranch).toBe("main");
    expect(view.steps.map((s) => [s.title, s.step_summary, s.additions, s.status])).toEqual([
      ["Step 1", "did step 1", 1, "in_review"],
      ["Step 2", "did step 2", 2, "in_review"],
      ["Step 3", "", 0, "not_started"],
    ]);
    expect(view.stats).toMatchObject({ total: 3, finished: 2, waiting: 1, merged: 0 });
    expect(view.targetId).toBe(ids[1]); // last step with a branch
    // Step 3 hasn't run: merging through it is refused, through step 2 allowed.
    expect(view.steps[2].mergeBlocker).toMatch(/hasn't run yet/);
    expect(view.steps[1].mergeBlocker).toBeNull();
  });

  it("merge up to step k: lands 1..k, marks them done, later steps keep their stack and merge later", async () => {
    const { repo, chain, ids } = await makeStackedChain(3);
    const res = await mergeChain(chain.id, ids[1]);
    expect(res.ok).toBe(true);
    expect(res.mergedTaskIds).toEqual([ids[0], ids[1]]);
    expect(await onMain(repo, "step2.txt")).toBe(true);
    expect(await onMain(repo, "step3.txt")).toBe(false);
    expect([getTask(ids[0])!.status, getTask(ids[1])!.status, getTask(ids[2])!.status]).toEqual(["done", "done", "in_review"]);
    expect(getTask(ids[2])!.merged_at).toBe(0);

    // Step 3 still stacks on step 2's branch (no rebase) and still shows only its own work.
    const s3 = getTask(ids[2])!;
    expect(await git(repo, "merge-base", "--is-ancestor", getTask(ids[1])!.work_branch, s3.work_branch).then(() => true)).toBe(true);
    const view = (await getChainView(chain.id))!;
    expect(view.steps[2]).toMatchObject({ additions: 3, merged: false, mergeBlocker: null });
    expect(view.steps[1].mergeBlocker).toMatch(/already merged/);

    // Landing the rest merges only step 3 and records only its row.
    const rest = await mergeChain(chain.id);
    expect(rest.ok).toBe(true);
    expect(rest.mergedTaskIds).toEqual([ids[2]]);
    expect(await onMain(repo, "step3.txt")).toBe(true);
    expect(ids.map((id) => merges(id).length)).toEqual([1, 1, 1]);
  });

  it("refuses while any step in the chain is running", async () => {
    const { repo, chain, ids } = await makeStackedChain(3);
    const ac = new AbortController();
    registerTurn(ids[0], ac);
    try {
      await expect(mergeChain(chain.id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/step 1 .* is running/) });
      // Even merging only the steps before a running step is refused.
      registerTurn(ids[2], ac);
      await expect(mergeChain(chain.id, ids[1])).rejects.toBeInstanceOf(ChainError);
    } finally {
      unregisterTurn(ids[0], ac);
      unregisterTurn(ids[2], ac);
    }
    expect(await onMain(repo, "step1.txt")).toBe(false);
    expect(getTask(ids[0])!.status).toBe("in_review");
  });

  it("refuses a broken stack: an earlier step changed after the next one branched from it", async () => {
    const { repo, chain, ids } = await makeStackedChain(3);
    await commitFile(getTask(ids[0])!.worktree_path, "late.txt", "late follow-up\n", "late work on step 1");
    await expect(mergeChain(chain.id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/step 1 .* changed after step 2/) });
    expect(await onMain(repo, "step1.txt")).toBe(false);
    // Merging up to step 1 alone is still fine — it lands the late work too.
    const res = await mergeChain(chain.id, ids[0]);
    expect(res.ok).toBe(true);
    expect(await onMain(repo, "late.txt")).toBe(true);
  });

  it("marks merged steps done, which auto-starts dependents outside the chain", async () => {
    const { project, chain, ids } = await makeStackedChain(2);
    const outside = createTask({ project_id: project.id, title: "After the chain" });
    setTaskDeps(outside.id, [ids[1]]);
    updateTask(outside.id, { auto_start: 1 });
    const { readyAutoStartDependents } = await import("@/lib/autoStart");
    expect(readyAutoStartDependents(ids[1]).map((t) => t.id)).toEqual([]); // in_review still blocks outsiders
    const res = await mergeChain(chain.id);
    expect(res.ok).toBe(true);
    expect(getTask(ids[1])!.status).toBe("done");
    const until = Date.now() + 8000;
    while (!getTask(outside.id)!.started && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    expect(getTask(outside.id)!.started).toBe(1);
  });

  it("chainMergeBlocker is pure over the rows", () => {
    const row = (pos: number, status: Task["status"], extra: Partial<Task> = {}) =>
      ({ id: `t${pos}`, title: `T${pos}`, chain_pos: pos, status, running: 0, merged_at: 0, worktree_path: "/wt", work_branch: "b", ...extra }) as Task;
    const steps = [row(0, "done", { merged_at: 1 }), row(1, "in_review"), row(2, "in_progress")];
    const none = () => false;
    expect(chainMergeBlocker(steps, steps[2], none)).toBeNull(); // a paused target is the user's call
    expect(chainMergeBlocker(steps, steps[0], none)).toMatch(/already merged/);
    expect(chainMergeBlocker(steps, steps[2], (t) => t.id === "t2")).toMatch(/running/);
    expect(chainMergeBlocker([...steps, row(3, "cancelled")], row(3, "cancelled"), none)).toMatch(/cancelled/);
  });
});

describe("merge chain — conflict path", () => {
  async function conflictingChain() {
    const fx = await makeStackedChain(3);
    // The last step (which holds the whole stack) edits file.txt…
    const wt = getTask(fx.ids[2])!.worktree_path;
    fs.writeFileSync(path.join(wt, "file.txt"), "line one\nchain edit\n");
    await commitWorktree(wt, "step 3 edits file.txt");
    // …while main moved on the same line.
    await commitFile(fx.repo, "file.txt", "line one\nmain edit\n", "main edit");
    return fx;
  }

  it("reports conflicts naming the target step, resolves in its worktree, and the retry lands every step", async () => {
    const { repo, chain, ids } = await conflictingChain();
    const res = await mergeChain(chain.id);
    expect(res.ok).toBe(false);
    expect(res.conflicts).toEqual(["file.txt"]);
    expect(res.targetTaskId).toBe(ids[2]);
    expect(ids.map((id) => getTask(id)!.status)).toEqual(["in_review", "in_review", "in_review"]);

    // The AI conflict flow: trial-merge main into the last step's worktree.
    const prep = await prepareChainMerge(chain.id);
    expect(prep).toMatchObject({ ok: true, clean: false, conflicts: ["file.txt"], targetTaskId: ids[2], baseBranch: "main" });
    const wt = getTask(ids[2])!.worktree_path;
    expect((await worktreeMergeStatus(wt)).mergeInProgress).toBe(true);
    expect((await getChainView(chain.id))!.resolution).toEqual({ taskId: ids[2], unresolved: ["file.txt"] });

    // The resolution turn edits the markers out (without staging, as agents do)…
    fs.writeFileSync(path.join(wt, "file.txt"), "line one\nmain edit\nchain edit\n");
    // …and the retry completes the staged merge and lands the whole chain.
    const retry = await mergeChain(chain.id);
    expect(retry.ok).toBe(true);
    expect(retry.mergedTaskIds).toEqual(ids);
    expect(await git(repo, "show", "main:file.txt")).toBe("line one\nmain edit\nchain edit");
    for (const f of ["step1.txt", "step2.txt", "step3.txt"]) expect(await onMain(repo, f)).toBe(true);
    expect(ids.map((id) => getTask(id)!.status)).toEqual(["done", "done", "done"]);
    // Step 3's insights row counts its own work, not main's changes pulled in by the resolution merge.
    expect(merges(ids[2])).toEqual([{ additions: 4, deletions: 1 }]);
    expect(listChainSteps(chain.id).every((s) => s.merged_at > 0)).toBe(true);
  });

  it("a retry with conflict markers still in place is refused and lands nothing", async () => {
    const { repo, chain, ids } = await conflictingChain();
    await prepareChainMerge(chain.id);
    const retry = await mergeChain(chain.id);
    expect(retry.ok).toBe(false);
    expect(retry.error).toMatch(/conflict markers/);
    expect(await onMain(repo, "step1.txt")).toBe(false);
    expect(getTask(ids[0])!.status).toBe("in_review");
  });

  it("a clean trial merge lands the chain straight from prepare", async () => {
    const { repo, chain, ids } = await makeStackedChain(2);
    await commitFile(repo, "unrelated.txt", "main moved\n", "unrelated main work");
    const prep = await prepareChainMerge(chain.id);
    expect(prep).toMatchObject({ ok: true, clean: true });
    expect(prep.merged?.ok).toBe(true);
    expect(await onMain(repo, "step2.txt")).toBe(true);
    expect(ids.map((id) => getTask(id)!.status)).toEqual(["done", "done"]);
    expect(merges(ids[1])).toEqual([{ additions: 2, deletions: 0 }]);
  });
});

describe("chain card derivation (app/orchestrator/chains.ts)", () => {
  const row = (id: string, pos: number, status: Task["status"], extra: Record<string, unknown> = {}) =>
    ({ id, chain_id: "c1", chain_mode: "auto_review", chain_pos: pos, status, running: 0, awaiting_input: 0, ...extra }) as unknown as TaskRow;

  it("shows a chain once a step is In review, with progress, until every step is finished", () => {
    const none = new Set<string>();
    expect(chainsForReview([row("a", 0, "in_progress"), row("b", 1, "not_started")], none)).toEqual([]);
    const [c] = chainsForReview([row("c", 2, "in_progress"), row("a", 0, "in_review"), row("b", 1, "in_review")], new Set(["c"]));
    expect(c.steps.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(c).toMatchObject({ total: 3, finished: 2, running: 1, paused: 0, done: 0 });
    expect(chainProgressLabel(c)).toBe("2 of 3 finished · 1 running");
    // After a partial merge the card stays even with nothing In review…
    expect(chainsForReview([row("a", 0, "done"), row("b", 1, "in_progress")], none)).toHaveLength(1);
    // …and goes away once every step is done.
    expect(chainsForReview([row("a", 0, "done"), row("b", 1, "done")], none)).toEqual([]);
    // Non-auto-advance chains never get a card.
    expect(chainsForReview([row("a", 0, "in_review", { chain_mode: null })], none)).toEqual([]);
  });
});
