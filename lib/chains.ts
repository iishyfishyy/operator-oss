// Auto-advance chains — the DB-side rules (no git, no turn launching).
//
// A chain is an ordered run of tasks (chains table + tasks.chain_id/chain_pos)
// built by the composer's "Auto-advance, review at end" mode. Each step says
// it's finished by calling the complete_step tool; when that turn ends cleanly
// the runner hands off to finishChainStep (lib/autoStart.ts), which commits the
// step's worktree, moves it to in_review, and starts the next step on a
// worktree branched from this step's branch (stacked — the base branch is
// never touched; the user reviews and merges the whole stack at the end).
//
// SDK-free on purpose (pinned in tests/importGraph.test.ts): lib/agentTools.ts,
// lib/agents/shared.ts and the runner all read these rules.

import { getChain, getTask, updateTask, previousChainStep } from "./store";
import { AUTO_ADVANCE_MODE } from "./chainRules";
import type { Project, Task } from "./types";

/** Is this task a step of an auto-advance chain (the only kind complete_step is offered to)? */
export function isAutoAdvanceTask(task: Pick<Task, "chain_id">): boolean {
  return !!task.chain_id && getChain(task.chain_id)?.mode === AUTO_ADVANCE_MODE;
}

/** The chain mode of `task`'s chain, for the shared blocker rule (lib/chainRules.ts). */
export function chainModeOf(task: Pick<Task, "chain_id">): string | null {
  return task.chain_id ? getChain(task.chain_id)?.mode ?? null : null;
}

/**
 * Where a task's worktree should branch from. A step of an auto-advance chain
 * stacks on the previous step's branch (so it sees that work, and its base_sha
 * — the previous step's last commit — makes its diff show only its own
 * changes). Everything else, and a step whose predecessor never got a branch
 * (non-git fallback), branches from the project's base branch as always.
 */
export function worktreeBaseFor(task: Task, project: Project): string {
  if (isAutoAdvanceTask(task)) {
    const prev = previousChainStep(task);
    if (prev?.work_branch) return prev.work_branch;
  }
  return project.branch;
}

/**
 * The complete_step tool's behavior, shared by the Claude driver's in-process
 * MCP server and the stdio bridge's internal endpoint. Records the summary and
 * WHEN it was called — the runner compares that timestamp with the turn's start
 * to know the call happened during the turn that's ending. Nothing advances
 * here: the turn may still ask a question or get a queued follow-up, and the
 * runner's safety checks run only once it ends.
 */
export function recordStepComplete(taskId: string, summary: string): { ok: boolean; text: string } {
  const task = getTask(taskId);
  if (!task) return { ok: false, text: "This task no longer exists." };
  if (!isAutoAdvanceTask(task)) {
    return { ok: false, text: "This task isn't part of an auto-advance chain, so there is no step to complete. Just finish your reply." };
  }
  updateTask(taskId, { step_summary: summary.trim(), step_completed_at: Date.now() });
  return {
    ok: true,
    text:
      "Step recorded as complete. When this turn ends the orchestrator commits your work and starts the next step of the chain " +
      "on top of it. Finish your reply now — don't ask the user anything after this (a question pauses the chain here instead).",
  };
}

/** Everything the runner knows when a turn ends, for the advance decision. */
export interface TurnEndState {
  task: Task | undefined; // the row as it stands now (re-read in the runner's finally)
  generation: number; // the generation the turn ran in
  turnStartedAt: number; // ms epoch the turn started
  turnError: string | null; // any failure (context overflow, dead login, approval block, usage limit, crash)
  stopped: boolean; // the user pressed Stop
  superseded: boolean; // a successor turn already owns the task
  openAsks: number; // asks this turn parked that are still unanswered
  pendingAsk: boolean; // an ask still parked in lib/asks.ts (the ask_user bridge path)
  pendingMessages: number; // queued follow-ups waiting to run
}

/**
 * Why a finished turn must NOT advance its chain, or null when it may. Every
 * non-null answer is a pause: the runner leaves awaiting_input set, so the step
 * shows up in "N need you" like any other turn that ended mid-task.
 */
export function chainAdvanceBlocker(s: TurnEndState): string | null {
  const t = s.task;
  if (!t) return "task deleted";
  if (!isAutoAdvanceTask(t)) return "not an auto-advance chain step";
  if (t.generation !== s.generation) return "generation changed";
  if (s.superseded) return "superseded by a newer turn";
  if (s.stopped) return "stopped";
  if (s.turnError) return "turn failed";
  if (!t.step_completed_at || t.step_completed_at < s.turnStartedAt) return "complete_step not called this turn";
  if (s.openAsks > 0 || s.pendingAsk) return "open question";
  if (s.pendingMessages > 0) return "queued messages";
  if (t.status !== "in_progress") return `status is ${t.status}`;
  return null;
}
