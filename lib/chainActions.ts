// Chain review actions — phase 3 of auto-advance chains (lib/chains.ts,
// lib/chainMerge.ts): Send back with feedback, Discard from step k, Rebase the
// stack onto a moved base branch, and keeping a chain whole when one of its
// steps is deleted.
//
// Every action runs under the per-task lock of EVERY step (withStepLocks, in
// chain order — the same contract as the chain merge), so "nothing is running"
// is checked atomically with the git work and the turn launch.

import fs from "node:fs";
import {
  getChain,
  getProject,
  getTask,
  updateTask,
  deleteTask,
  listChainSteps,
  listChainFixups,
  addChainFixup,
  deleteChainFixup,
  countAwaiting,
  getTaskDeps,
  setTaskDeps,
  previousChainStep,
  nextChainStep,
} from "@/lib/store";
import { revParse, removeWorktree, rebaseWorktreeOnto, resetWorktreeHard, worktreeDirty, worktreeMergeStatus, hasMergeCommits } from "@/lib/git";
import { abortTurn, claimTurn, unregisterTurn } from "@/lib/abort";
import { startResumeTurn } from "@/lib/runner";
import { publishGlobal } from "@/lib/events";
import { removeTaskUploads } from "@/lib/uploads";
import { maybeAutoStartDependents } from "@/lib/autoStart";
import { buildFixupPrompt } from "@/lib/chains";
import { AUTO_ADVANCE_MODE } from "@/lib/chainRules";
import { buildOpeningPrompt } from "@/lib/agents/shared";
import { MAX_MESSAGE_CHARS } from "@/lib/promptLimits";
import { ChainError, stepMerged, stepRunning, stepLabel, withStepLocks, sendBackBlocker, sendBackTarget } from "@/lib/chainMerge";
import type { ChainFixup, Task } from "@/lib/types";

/**
 * POST /api/chains/[id]/send-back: run the user's review feedback as a fix-up
 * turn on the chain's last step — its worktree already contains every step, so
 * nothing is rebased. Goes through the normal resume path (startResumeTurn);
 * when the turn calls complete_step, finishChainStep commits it and the step
 * (and so the chain) is back In review. `aboutId` names the step the feedback
 * is about; its summary goes into the prompt.
 */
export async function sendBackChain(chainId: string, feedback: string, aboutId?: string): Promise<{ ok: true; taskId: string; fixupId: string }> {
  const text = feedback.trim();
  if (!text) throw new ChainError(400, "write some feedback first");
  if (text.length > MAX_MESSAGE_CHARS) throw new ChainError(413, "feedback is too long");
  const chain = getChain(chainId);
  if (!chain) throw new ChainError(404, "chain not found");
  const ids = listChainSteps(chainId).map((s) => s.id);
  return withStepLocks(ids, async () => {
    const steps = listChainSteps(chainId);
    const project = getProject(chain.project_id);
    if (!project) throw new ChainError(400, "no project");
    const blocker = sendBackBlocker(steps, listChainFixups(chainId));
    if (blocker) throw new ChainError(409, blocker);
    const last = sendBackTarget(steps)!;
    const about = aboutId ? steps.find((s) => s.id === aboutId) : null;
    if (aboutId && !about) throw new ChainError(400, "that task isn't a step of this chain");
    if (!fs.existsSync(last.worktree_path)) throw new ChainError(400, `${stepLabel(last)}'s worktree no longer exists`);

    const controller = claimTurn(last.id);
    if (!controller) throw new ChainError(409, `${stepLabel(last)} is running — wait for it to finish`);
    let fixup: ChainFixup | undefined;
    try {
      fixup = addChainFixup({
        chain_id: chainId,
        task_id: last.id,
        about_task_id: about?.id ?? null,
        about_pos: about?.chain_pos ?? null,
        feedback: text,
        start_sha: await revParse(last.worktree_path, "HEAD"),
      });
      const prompt = buildFixupPrompt({ feedback: text, steps: steps.filter((s) => !stepMerged(s)), about, last });
      // The fix-up is the step working again: out of In review until it
      // finishes, so the chain stops counting as "waiting for review".
      const fresh = updateTask(last.id, { status: "in_progress", step_pause: "" })!;
      // After a /clear the session is fresh (started=0): open it the way the
      // messages route would, with the resume preamble around the feedback.
      await startResumeTurn(fresh, project, fresh.started ? prompt : buildOpeningPrompt(fresh, prompt), controller);
      return { ok: true as const, taskId: last.id, fixupId: fixup.id };
    } catch (err) {
      unregisterTurn(last.id, controller);
      if (fixup) deleteChainFixup(fixup.id);
      if (getTask(last.id)?.status === "in_progress" && last.status !== "in_progress") updateTask(last.id, { status: last.status });
      throw err;
    }
  });
}

/**
 * POST /api/chains/[id]/discard: hard-delete steps k..n (delete is hard delete
 * throughout the app) — stop their turns, remove their worktrees AND branches,
 * drop the rows. Steps 1..k-1 are untouched: still reviewable, still
 * mergeable. Refused when a step in the range is already merged (its work is
 * in the base branch; deleting the task wouldn't undo that).
 */
export async function discardChainFrom(chainId: string, fromId: string): Promise<{ ok: true; deleted: string[] }> {
  const chain = getChain(chainId);
  if (!chain) throw new ChainError(404, "chain not found");
  const ids = listChainSteps(chainId).map((s) => s.id);
  return withStepLocks(ids, async () => {
    const steps = listChainSteps(chainId);
    const from = steps.find((s) => s.id === fromId);
    if (!from) throw new ChainError(400, "that task isn't a step of this chain");
    const range = steps.filter((s) => (s.chain_pos ?? 0) >= (from.chain_pos ?? 0));
    const merged = range.find(stepMerged);
    if (merged) throw new ChainError(409, `${stepLabel(merged)} is already merged — it can't be discarded`);
    const project = getProject(chain.project_id);
    // Last step first, so no surviving step ever stacks on a removed branch.
    for (const s of [...range].reverse()) {
      abortTurn(s.id);
      if (s.worktree_path && project?.repo_path) await removeWorktree(project.repo_path, s.worktree_path, s.work_branch);
      removeTaskUploads(s.id);
      deleteTask(s.id);
      publishGlobal(s.id, { type: "task_deleted", projectId: chain.project_id, awaiting_count: countAwaiting(chain.project_id) });
    }
    return { ok: true as const, deleted: range.map((s) => s.id) };
  });
}

/**
 * A step was deleted on its own (DELETE /api/tasks/[id]) while its chain
 * lives on. The step after it lost its dependency edge with the row (the edge
 * cascades), so it would never auto-start: re-link it to the nearest earlier
 * step (previousChainStep skips the gap, so it also stacks on that step's
 * branch), and advance right away if that step has already finished.
 *
 * A later step that had ALREADY stacked on the deleted one still carries its
 * commits — the chain view warns about that and the merge refuses it
 * (orphanedStackProblem in lib/chainMerge.ts) until the stack is rebased or
 * discarded.
 */
export function relinkAfterStepDelete(deleted: Pick<Task, "id" | "chain_id" | "chain_pos">): void {
  if (!deleted.chain_id || deleted.chain_pos == null) return;
  if (getChain(deleted.chain_id)?.mode !== AUTO_ADVANCE_MODE) return; // gone with its last step, or not auto-advance
  const next = nextChainStep(deleted);
  if (!next || next.started) return;
  const prev = previousChainStep(next);
  if (!prev) return;
  const deps = getTaskDeps(next.id);
  if (!deps.includes(prev.id)) {
    try {
      setTaskDeps(next.id, [...deps, prev.id]);
    } catch (err) {
      console.error(`[chainActions] could not re-link chain step ${next.id}:`, err);
      return;
    }
  }
  if (prev.status === "in_review" || prev.status === "done") maybeAutoStartDependents(prev.id);
}

export type RebaseOutcome =
  | { ok: true; rebased: string[] }
  | { ok: false; error: string; conflicts: string[]; taskId: string };

/**
 * POST /api/chains/[id]/rebase: the chain's base branch moved on — replay the
 * unmerged stack onto its new tip, step by step (`git rebase --onto`, each
 * step onto the rebased tip of the one before, from its own base_sha), and
 * advance each step's base_sha so its diff still shows only its own work.
 * All or nothing: a conflict anywhere resets every already-rebased step to
 * its old tip and reports the conflicted step — the merge's "Fix with AI" path
 * is the way through a conflicting base. Needs every step clean and idle.
 *
 * Also drops a deleted step's commits from a later step that had stacked on
 * it: that step replays only its own commits (from its base_sha).
 */
export async function rebaseChainStack(chainId: string): Promise<RebaseOutcome> {
  const chain = getChain(chainId);
  if (!chain) throw new ChainError(404, "chain not found");
  const ids = listChainSteps(chainId).map((s) => s.id);
  return withStepLocks(ids, async () => {
    const steps = listChainSteps(chainId);
    const project = getProject(chain.project_id);
    if (!project) throw new ChainError(400, "no project");
    const live = steps.find(stepRunning);
    if (live) throw new ChainError(409, `${stepLabel(live)} is running — wait for it to finish`);
    const stack = steps.filter((s) => !stepMerged(s) && s.work_branch && s.worktree_path);
    if (stack.length === 0) throw new ChainError(409, "nothing left to rebase");
    for (const s of stack) {
      if (!fs.existsSync(s.worktree_path)) throw new ChainError(400, `${stepLabel(s)}'s worktree no longer exists`);
      if (!s.base_sha) throw new ChainError(409, `${stepLabel(s)} has no recorded base to rebase from`);
      if ((await worktreeMergeStatus(s.worktree_path)).mergeInProgress)
        throw new ChainError(409, `${stepLabel(s)} has a conflict resolution in progress — finish or discard it first`);
      if (await worktreeDirty(s.worktree_path))
        throw new ChainError(409, `${stepLabel(s)} has uncommitted changes — let it finish (or commit them) before rebasing`);
      // A rebase replays only non-merge commits, so edits made inside a merge
      // (e.g. conflict fixes from a manual Sync) would vanish without a word.
      if (await hasMergeCommits(s.worktree_path, s.base_sha))
        throw new ChainError(409, `${stepLabel(s)} contains a merge commit that a rebase would drop — merge the chain instead (Fix with AI handles conflicts)`);
    }
    const baseBranch = chain.base_branch || project.branch;
    let onto = await revParse(project.repo_path, baseBranch);
    if (!onto) throw new ChainError(400, `base branch ${baseBranch} not found`);

    const done: { step: Task; oldTip: string; base: string }[] = [];
    for (const step of stack) {
      const oldTip = await revParse(step.worktree_path, "HEAD");
      const r = await rebaseWorktreeOnto(step.worktree_path, onto, step.base_sha);
      if (!r.ok) {
        for (const d of done.reverse()) await resetWorktreeHard(d.step.worktree_path, d.oldTip).catch(() => {});
        return {
          ok: false as const,
          error: `${stepLabel(step)} conflicts with ${baseBranch}${r.conflicts.length ? "" : `: ${r.error}`} — nothing was rebased. Merge the chain and use Fix with AI instead.`,
          conflicts: r.conflicts,
          taskId: step.id,
        };
      }
      done.push({ step, oldTip, base: onto });
      onto = r.tip;
    }
    for (const d of done) {
      updateTask(d.step.id, { base_sha: d.base });
      publishGlobal(d.step.id, { type: "task_updated" });
    }
    return { ok: true as const, rebased: done.map((d) => d.step.id) };
  });
}
