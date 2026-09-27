// Chain review + merge — phase 2 of auto-advance chains (lib/chains.ts).
//
// An auto-advance chain's steps are STACKED branches: each step's worktree
// branched from the previous step's branch (worktreeBaseFor), so the last
// step's work_branch contains every step before it. That makes "land the whole
// chain" one ordinary merge — mergeTask on the target step's branch into the
// chain's base branch — followed by bookkeeping on every step it carried
// (merged_at, status done, one task_merges insights row per step).
//
// "Merge up to step k" is the same merge with step k as the target. Steps
// after k KEEP THEIR STACK: nothing is rebased. Step k+1's branch still
// descends from step k's tip, which is now in the base branch, so its diff
// base (base_sha = step k's tip) still shows only its own work, and merging it
// later lands only the commits the base doesn't have yet. Rebasing instead
// would rewrite branches under live worktrees/agent sessions for no gain.
//
// Everything runs under the per-task lock of EVERY step in the chain (taken in
// chain order, so two chain merges can't deadlock), making the "nothing is
// running" check atomic with the git work — the same contract the single-task
// merge routes keep with the turn-launch path (lib/taskLock.ts).

import fs from "node:fs";
import { getChain, getProject, listChainSteps, updateTask, recordTaskMerge, taskMergeTotals } from "@/lib/store";
import {
  mergeTask,
  completeWorktreeMerge,
  prepareWorktreeMerge,
  worktreeMergeStatus,
  commitWorktree,
  worktreeDirty,
  isAncestor,
  stepOwnTip,
  commitRangeLineStats,
  worktreeLineStats,
  type MergeResult,
  type PrepareMergeResult,
} from "@/lib/git";
import { hasTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";
import { publishGlobal } from "@/lib/events";
import { maybeAutoStartDependents } from "@/lib/autoStart";
import type { Chain, Project, Status, Task } from "@/lib/types";

/** A validation failure the routes turn into an HTTP error (never a git outcome). */
export class ChainError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** A step is merged once the chain (or the user) landed it AND it's done. */
export const stepMerged = (t: Pick<Task, "status" | "merged_at">) => t.status === "done" && !!t.merged_at;

const stepRunning = (t: Task) => !!t.running || hasTurn(t.id);

const stepLabel = (t: Pick<Task, "chain_pos" | "title">) => `step ${(t.chain_pos ?? 0) + 1} ("${t.title}")`;

/**
 * Why the chain can't merge through `target` right now, or null when it may.
 * Pure over the rows (no git): the review panel shows this reason on the
 * button, and the merge re-checks it under the locks. Git-level stack checks
 * (stackProblem) run only at merge time.
 */
export function chainMergeBlocker(steps: Task[], target: Task, running: (t: Task) => boolean = stepRunning): string | null {
  const live = steps.find(running);
  if (live) return `${stepLabel(live)} is running — wait for it to finish before merging`;
  const range = steps.filter((s) => (s.chain_pos ?? 0) <= (target.chain_pos ?? 0) && !stepMerged(s));
  if (range.length === 0) return "everything through this step is already merged";
  for (const s of range) {
    if (s.status === "not_started") return `${stepLabel(s)} hasn't run yet`;
    if (s.status === "cancelled") return `${stepLabel(s)} was cancelled — its work won't be merged`;
  }
  if (!target.worktree_path || !target.work_branch) return `${stepLabel(target)} has no isolated branch to merge`;
  return null;
}

/** The last step that has a branch — what "Merge chain" and the Combined diff target by default. */
export function defaultTarget(steps: Task[]): Task | undefined {
  return [...steps].reverse().find((s) => s.work_branch && s.worktree_path) ?? steps[steps.length - 1];
}

export interface ChainStepView {
  id: string;
  title: string;
  status: Status;
  chain_pos: number;
  running: boolean;
  awaiting_input: boolean;
  agent: string;
  step_summary: string;
  work_branch: string;
  merged_at: number;
  merged: boolean;
  additions: number;
  deletions: number;
  /** Why "Merge up to here" is disabled (null = allowed). */
  mergeBlocker: string | null;
}

export interface ChainView {
  chain: Chain;
  baseBranch: string;
  steps: ChainStepView[];
  stats: { total: number; finished: number; merged: number; running: number; paused: number; waiting: number };
  /** The step "Merge chain" lands (the last one with a branch). */
  targetId: string | null;
  /** A conflict resolution staged in some step's worktree, awaiting the retry. */
  resolution: { taskId: string; unresolved: string[] } | null;
}

async function stepStats(repoPath: string, step: Task, baseBranch: string): Promise<{ additions: number; deletions: number }> {
  // Once merged, the diff base has moved to the merged tip — the recorded
  // insights rows are the only lasting record of what the step changed.
  if (stepMerged(step)) return taskMergeTotals(step.id);
  if (!step.work_branch || !step.base_sha) return { additions: 0, deletions: 0 };
  // A paused step may hold uncommitted edits (the real agents rarely commit
  // themselves; finishChainStep commits at in_review) — count them too.
  if (step.worktree_path && fs.existsSync(step.worktree_path) && (await worktreeDirty(step.worktree_path))) {
    return (await worktreeLineStats(step.worktree_path, step.base_sha)) ?? { additions: 0, deletions: 0 };
  }
  const tip = await stepOwnTip(repoPath, step.work_branch, baseBranch);
  return (await commitRangeLineStats(repoPath, step.base_sha, tip)) ?? { additions: 0, deletions: 0 };
}

/** GET /api/chains/[id]: every step in order with its summary, line counts, and merge eligibility. */
export async function getChainView(chainId: string): Promise<ChainView | undefined> {
  const chain = getChain(chainId);
  if (!chain) return undefined;
  const project = getProject(chain.project_id);
  const steps = listChainSteps(chainId);
  const baseBranch = chain.base_branch || project?.branch || "";
  const repo = project?.repo_path ?? "";

  const views = await Promise.all(
    steps.map(async (s): Promise<ChainStepView> => {
      const { additions, deletions } = repo ? await stepStats(repo, s, baseBranch) : { additions: 0, deletions: 0 };
      return {
        id: s.id,
        title: s.title,
        status: s.status,
        chain_pos: s.chain_pos ?? 0,
        running: stepRunning(s),
        awaiting_input: !!s.awaiting_input,
        agent: s.agent,
        step_summary: s.step_summary,
        work_branch: s.work_branch,
        merged_at: s.merged_at,
        merged: stepMerged(s),
        additions,
        deletions,
        mergeBlocker: chainMergeBlocker(steps, s),
      };
    })
  );

  let resolution: ChainView["resolution"] = null;
  for (const s of steps) {
    if (stepMerged(s) || !s.worktree_path || !fs.existsSync(s.worktree_path)) continue;
    const st = await worktreeMergeStatus(s.worktree_path);
    if (st.mergeInProgress) resolution = { taskId: s.id, unresolved: st.unresolved };
  }

  const stats = {
    total: steps.length,
    finished: steps.filter((s) => s.status === "in_review").length,
    merged: steps.filter(stepMerged).length,
    running: views.filter((v) => v.running).length,
    paused: steps.filter((s) => s.status === "in_progress" && !stepRunning(s)).length,
    waiting: steps.filter((s) => s.status === "not_started").length,
  };
  return { chain, baseBranch, steps: views, stats, targetId: defaultTarget(steps)?.id ?? null, resolution };
}

interface ChainCtx {
  chain: Chain;
  project: Project;
  steps: Task[];
  target: Task;
  range: Task[]; // unmerged steps up to and including target, in order
  baseBranch: string;
  message: string;
}

// Take every step's task lock, in chain order, then run fn. The order is fixed
// so two chain operations can never hold each other's locks.
async function withStepLocks<T>(ids: string[], fn: () => Promise<T>): Promise<T> {
  if (ids.length === 0) return fn();
  const [head, ...rest] = ids;
  return withTaskLock(head, () => withStepLocks(rest, fn));
}

async function underChainLock<T>(chainId: string, throughId: string | undefined, fn: (ctx: ChainCtx) => Promise<T>): Promise<T> {
  const chain = getChain(chainId);
  if (!chain) throw new ChainError(404, "chain not found");
  const ids = listChainSteps(chainId).map((s) => s.id);
  return withStepLocks(ids, async () => {
    // Re-read everything under the locks: a turn may have launched, a step may
    // have been re-statused or deleted while we queued.
    const steps = listChainSteps(chainId);
    const project = getProject(chain.project_id);
    if (!project) throw new ChainError(400, "no project");
    if (steps.length === 0) throw new ChainError(404, "chain has no steps");
    const target = throughId ? steps.find((s) => s.id === throughId) : defaultTarget(steps);
    if (!target) throw new ChainError(400, "that task isn't a step of this chain");
    const blocker = chainMergeBlocker(steps, target);
    if (blocker) throw new ChainError(409, blocker);
    if (!fs.existsSync(target.worktree_path)) throw new ChainError(400, `${stepLabel(target)}'s worktree no longer exists`);
    const range = steps.filter((s) => (s.chain_pos ?? 0) <= (target.chain_pos ?? 0) && !stepMerged(s));
    const baseBranch = chain.base_branch || project.branch;
    const problem = await stackProblem(project.repo_path, range);
    if (problem) throw new ChainError(409, problem);
    const first = range[0];
    const span = first.id === target.id ? `step ${(target.chain_pos ?? 0) + 1}` : `steps ${(first.chain_pos ?? 0) + 1}–${(target.chain_pos ?? 0) + 1}`;
    const message = `${first.id === target.id ? target.title : `${first.title} … ${target.title}`} (orchestrator chain ${chain.id}, ${span})`;
    return fn({ chain, project, steps, target, range, baseBranch, message });
  });
}

/**
 * Is the stack still a stack? Landing the target's branch only carries earlier
 * steps' work if each earlier step's branch is an ancestor of the next one and
 * holds no uncommitted edits. Either breaks when a step got more work after
 * the next step branched from it (a follow-up message) — merging would
 * silently drop that work, so refuse and say which step diverged.
 */
async function stackProblem(repoPath: string, range: Task[]): Promise<string | null> {
  for (let i = 0; i < range.length - 1; i++) {
    const prev = range[i], next = range[i + 1];
    if (prev.worktree_path && fs.existsSync(prev.worktree_path) && (await worktreeDirty(prev.worktree_path)))
      return `${stepLabel(prev)} has uncommitted changes that later steps don't include — commit them into a later step or discard them, or merge up to ${stepLabel(prev)} alone`;
    if (!prev.work_branch || !(await isAncestor(repoPath, prev.work_branch, next.work_branch)))
      return `${stepLabel(prev)} changed after ${stepLabel(next)} branched from it, so the stack no longer carries its work — merge up to ${stepLabel(prev)} first`;
  }
  return null;
}

export type ChainMergeOutcome = MergeResult & { targetTaskId: string; mergedTaskIds: string[] };

// The land step shared by merge and a clean prepare. Called with the locks held.
async function land(ctx: ChainCtx): Promise<ChainMergeOutcome> {
  const { project, target, range, baseBranch, message } = ctx;
  const repo = project.repo_path;
  const resolving = (await worktreeMergeStatus(target.worktree_path)).mergeInProgress;

  // Commit the target's pending edits first (unless a resolution merge is
  // staged — completeWorktreeMerge commits that), so its line stats below see
  // everything that's about to land.
  if (!resolving) {
    try {
      await commitWorktree(target.worktree_path, message);
    } catch (e) {
      return { ok: false, targetBranch: baseBranch, committed: false, error: `commit failed: ${e instanceof Error ? e.message : String(e)}`, targetTaskId: target.id, mergedTaskIds: [] };
    }
  }

  // Per-step line stats + "already in the base" — read BEFORE the merge, while
  // every branch is still exactly what was reviewed (worktrees may be pruned
  // once the steps are done, and the merge moves the base under the check).
  const per = await Promise.all(
    range.map(async (s) => {
      const tip = await stepOwnTip(repo, s.work_branch, baseBranch);
      const stats = (await commitRangeLineStats(repo, s.base_sha, tip)) ?? { additions: 0, deletions: 0 };
      return { step: s, tip, stats, landed: await isAncestor(repo, tip, baseBranch) };
    })
  );

  const input = { repoPath: repo, worktreePath: target.worktree_path, workBranch: target.work_branch, baseBranch, message };
  const result = resolving ? await completeWorktreeMerge(input) : await mergeTask(input);
  if (!result.ok) return { ...result, targetTaskId: target.id, mergedTaskIds: [] };

  const now = Date.now();
  for (const { step, tip, stats, landed } of per) {
    // Advance each step's diff base to what landed (as the single-task merge
    // does) so its Changes tab reads "merged · up to date" and the diff
    // route's post-merge-work check doesn't clear merged_at again.
    const base = step.id === target.id ? result.mergedSha || tip : tip;
    updateTask(step.id, { merged_at: now, status: "done", awaiting_input: 0, ...(base ? { base_sha: base } : {}) });
    // One insights row per step, with that step's own lines — the combined
    // merge's total would credit every line to the last step. A step whose
    // work was already in the base (merged some other way) lands nothing now.
    if (!landed) recordTaskMerge({ project_id: project.id, task_id: step.id, agent: step.agent, ...stats });
    publishGlobal(step.id, { type: "task_updated" });
  }
  return { ...result, targetTaskId: target.id, mergedTaskIds: range.map((s) => s.id) };
}

// Merged steps are done now: that's the last blocker for any dependent
// outside the chain. Outside the locks — each launch takes its own task lock.
function afterMerge(outcome: { mergedTaskIds?: string[] }) {
  for (const id of outcome.mergedTaskIds ?? []) maybeAutoStartDependents(id);
}

/**
 * POST /api/chains/[id]/merge: land the chain (or everything through
 * `throughId`) into its base branch in one merge. Conflicts come back as a
 * failed result naming the target step — the client then runs the AI
 * resolution flow (prepareChainMerge) on that step and retries.
 */
export async function mergeChain(chainId: string, throughId?: string): Promise<ChainMergeOutcome> {
  const outcome = await underChainLock(chainId, throughId, land);
  afterMerge(outcome);
  return outcome;
}

export type ChainPrepareOutcome = PrepareMergeResult & { targetTaskId: string; baseBranch: string; merged?: ChainMergeOutcome };

/**
 * The conflict path: trial-merge the base branch INTO the target step's
 * worktree (prepareWorktreeMerge), leaving markers for an AI resolution turn on
 * that step. A clean trial merge lands the chain right away. After the
 * resolution turn, a plain mergeChain retry sees the staged merge and
 * completes it (completeWorktreeMerge).
 */
export async function prepareChainMerge(chainId: string, throughId?: string): Promise<ChainPrepareOutcome> {
  const outcome = await underChainLock(chainId, throughId, async (ctx): Promise<ChainPrepareOutcome> => {
    const prep = await prepareWorktreeMerge({
      repoPath: ctx.project.repo_path,
      worktreePath: ctx.target.worktree_path,
      baseBranch: ctx.baseBranch,
      message: ctx.message,
    });
    const base: ChainPrepareOutcome = { ...prep, targetTaskId: ctx.target.id, baseBranch: ctx.baseBranch };
    if (!prep.ok || !prep.clean) return base;
    return { ...base, merged: await land(ctx) };
  });
  if (outcome.merged) afterMerge(outcome.merged);
  return outcome;
}
