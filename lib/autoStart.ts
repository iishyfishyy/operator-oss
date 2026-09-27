// Opt-in pipeline auto-start.
//
// A blocked task never starts on its own — deliberately — unless the user set
// its `auto_start` flag ("Start when unblocked"). When a task is marked done
// (the only way a blocker finishes: the user owns the done status, set via
// PATCH /api/tasks/[id]), this module finds its auto-start dependents whose
// LAST unfinished blocker just cleared and launches each one's first turn,
// exactly as if the user had pressed "Start session".
//
// Auto-advance chains (lib/chains.ts) add a second trigger: a chain step that
// finished cleanly (complete_step + a clean turn end) is committed and moved to
// in_review by finishChainStep below, which then runs the same dependent
// launch. in_review only unblocks the next step of the SAME chain (the shared
// rule in lib/chainRules.ts), and that step's worktree stacks on the previous
// step's branch — the base branch is never touched.
//
// The launch mirrors the initial-turn branch of POST /api/tasks/[id]/messages
// (claim the turn slot, ensure the worktree under the per-task lock, persist +
// publish the generic opening prompt, hand off to lib/runner.ts) — kept in
// step with that route; the turn itself runs detached exactly like any other.

import fs from "node:fs";
import {
  getTask,
  getProject,
  getTaskDeps,
  updateTask,
  addMessage,
  listAutoStartCandidates,
} from "@/lib/store";
import { startTurn } from "@/lib/runner";
import { claimTurn, unregisterTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";
import { publish } from "@/lib/events";
import { publishGlobal } from "@/lib/events";
import { ensureWorktree, commitWorktree } from "@/lib/git";
import { buildOpeningPrompt } from "@/lib/agents/shared";
import { depBlocks } from "@/lib/chainRules";
import { chainModeOf, worktreeBaseFor, isAutoAdvanceTask } from "@/lib/chains";
import { hasTurn } from "@/lib/abort";
import type { Task } from "@/lib/types";

// Is this dependency still blocking `dependent`? The shared rule the client's
// blockerTitles() also uses (lib/chainRules.ts): done AND cancelled are
// terminal; in_review is finished only for a dependent in the same
// auto-advance chain. A dep whose row was deleted doesn't block either (the
// edge cascades away with it).
function blocks(depId: string, dependent: Task): boolean {
  const dep = getTask(depId);
  return !!dep && depBlocks(dep, { chain_id: dependent.chain_id, chain_mode: chainModeOf(dependent) });
}

/**
 * The auto-start dependents of `doneTaskId` that are now fully unblocked.
 * Pure DB read (no side effects) — split out so tests can pin the selection
 * rules without launching turns.
 */
export function readyAutoStartDependents(doneTaskId: string): Task[] {
  return listAutoStartCandidates(doneTaskId).filter(
    (t) => !getTaskDeps(t.id).some((d) => blocks(d, t))
  );
}

/**
 * Called after a task's status flips to done (or to in_review — a finished
 * auto-advance chain step, which only readies its own chain's next step). Launches every ready auto-start
 * dependent, fire-and-forget: the caller is an HTTP PATCH that must not wait
 * on worktree creation, and a failed launch must never break the status
 * change. setTaskDeps' cycle guard means a done task can never (transitively)
 * depend on anything this launches, so a launch can't re-block the trigger.
 */
export function maybeAutoStartDependents(doneTaskId: string): void {
  const done = getTask(doneTaskId);
  const note = !done
    ? "▶ Auto-started — last blocker is done."
    : done.status === "in_review"
      ? `▶ Auto-advanced — "${done.title}" finished; stacked on its branch.`
      : `▶ Auto-started — "${done.title}" is done.`;
  for (const t of readyAutoStartDependents(doneTaskId)) {
    launchInitialTurn(t.id, note).catch((err) => {
      console.error(`[autoStart] could not start task ${t.id}:`, err);
    });
  }
}

// Start a never-started task's first turn, exactly like the POST /messages
// initial branch. Every non-launch exit releases the claim (or the task would
// read "running" forever); every guard re-checks under the per-task lock,
// because a user click can race this launch.
async function launchInitialTurn(taskId: string, note: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) return;
  const project = getProject(task.project_id);
  // No working directory — the same precondition the route enforces. Leave the
  // task blocked-but-startable; the user gets the route's error when they try.
  if (!project || !project.repo_path.trim()) return;
  // Atomically claim the turn slot. Occupied means a turn is already live
  // (e.g. the user pressed Start in the same instant) — nothing to do.
  const controller = claimTurn(taskId);
  if (!controller) return;
  let launched = false;
  try {
    fs.mkdirSync(project.repo_path, { recursive: true });
    // Same lock the merge/sync routes and the POST route hold: never launch a
    // turn into a worktree mid-rewrite.
    await withTaskLock(taskId, async () => {
      // Re-read under the lock — the task may have been started, deleted,
      // re-statused, or had its deps changed while we waited.
      const fresh = getTask(taskId);
      if (!fresh || fresh.started || fresh.suggested || fresh.status !== "not_started" || !fresh.auto_start) return;
      if (getTaskDeps(taskId).some((d) => blocks(d, fresh))) return;
      // Same opening turn the POST route sends. In practice that's always the
      // task text — a /clear'd task is in_progress and so never reaches here —
      // but route through the same helper so the two launchers can't drift on
      // the generation-1-vs-resumed distinction.
      const userText = buildOpeningPrompt(fresh);

      // Give the task its own worktree + branch (self-heals a pruned one),
      // falling back to repo_path on any git hiccup — same as the route. A
      // chain step stacks on the previous step's branch (worktreeBaseFor).
      if (!fresh.worktree_path || !fs.existsSync(fresh.worktree_path)) {
        try {
          const wt = await ensureWorktree(project.repo_path, fresh.id, worktreeBaseFor(fresh, project));
          if (wt) {
            fresh.worktree_path = wt.path;
            fresh.work_branch = wt.branch;
            fresh.base_sha = wt.baseSha;
            updateTask(taskId, { worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha });
          }
        } catch {
          // fall back to repo_path
        }
      }

      const gen = fresh.generation;
      const userMsg = addMessage(taskId, gen, "user", userText);
      // Mark running immediately, but defer `started` until the agent actually
      // opens a session — a failed launch leaves the task cleanly retryable.
      updateTask(taskId, { running: 1, awaiting_input: 0 });
      publish(taskId, { type: "user", content: userMsg.content, msgId: userMsg.id, generation: gen, ts: userMsg.created_at });
      // The note rides the runner's syncNote slot: persisted + published at the
      // top of the turn, so the transcript records WHY this session began.
      startTurn(fresh, project, userText, note, controller);
      launched = true;
    });
  } finally {
    if (!launched) unregisterTurn(taskId, controller);
  }
}

/**
 * Finish an auto-advance chain step whose turn just ended cleanly (the runner
 * already ran the safety checks — lib/chains.ts chainAdvanceBlocker — and
 * cleared awaiting_input). Commits the step's worktree on its own branch (the
 * base branch is never touched), moves it to in_review, and launches the next
 * step, which stacks on this branch.
 *
 * Detached from the runner's synchronous finally, so everything is re-checked
 * under the per-task lock: the user may have sent a message, re-statused the
 * task, or /clear'd it in between — any of those means the step isn't
 * finished after all, and we leave it alone. A failed commit pauses the chain
 * (awaiting_input + a notice), exactly like any other turn that needs the user.
 */
export async function finishChainStep(taskId: string, generation: number, completedAt: number): Promise<void> {
  await withTaskLock(taskId, async () => {
    const task = getTask(taskId);
    if (!task || !isAutoAdvanceTask(task)) return;
    if (task.generation !== generation || task.step_completed_at !== completedAt) return;
    if (task.status !== "in_progress" || task.running || hasTurn(taskId)) return;

    if (task.worktree_path && fs.existsSync(task.worktree_path)) {
      const summary = task.step_summary.trim();
      const message = `${task.title}${summary ? `\n\n${summary}` : ""}\n\n(orchestrator chain step ${(task.chain_pos ?? 0) + 1}, task ${task.id})`;
      try {
        await commitWorktree(task.worktree_path, message);
      } catch (err) {
        const text = `⚠ Could not commit this chain step, so the chain is paused here: ${err instanceof Error ? err.message : String(err)}`;
        const m = addMessage(taskId, generation, "system", text);
        updateTask(taskId, { awaiting_input: 1 });
        publish(taskId, { type: "error", content: text, msgId: m.id, generation, ts: m.created_at });
        publishGlobal(taskId, { type: "task_updated" });
        return;
      }
    }

    updateTask(taskId, { status: "in_review", awaiting_input: 0 });
    const note = `✓ Step complete — committed on ${task.work_branch || "the working tree"} and moved to In review.`;
    const m = addMessage(taskId, generation, "system", note);
    publish(taskId, { type: "notice", content: note, msgId: m.id, generation, ts: m.created_at });
    publishGlobal(taskId, { type: "task_updated" });
  });
  // Outside the lock: each dependent launch takes ITS OWN task lock.
  if (getTask(taskId)?.status === "in_review") maybeAutoStartDependents(taskId);
}
