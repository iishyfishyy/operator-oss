// Auto-advance chains as the tasks column sees them. Pure (no React), derived
// from the project's task rows — which the /api/events global stream keeps
// live (status / running / awaiting_input) — so the chain card needs no fetch
// and no polling of its own.
import type { TaskRow } from "./types";

export const AUTO_ADVANCE_MODE = "auto_review";

export interface ChainSummary {
  id: string;
  steps: TaskRow[]; // in chain order
  total: number;
  finished: number; // In review: called complete_step, waiting for the review
  done: number; // done (a chain merge marks every landed step done)
  running: number;
  paused: number; // in progress, no live turn (ended mid-task / waiting on you)
  waiting: number; // not started yet
  /** The first step waiting on the user (a phase 1 safety-check pause), if any. */
  pausedStep: TaskRow | null;
  /** Why it paused, in words ("" when no step is paused). */
  pauseReason: string;
  /** Every step finished and nothing is running: the chain is waiting for its review. */
  awaitsReview: boolean;
}

export type StepState = "done" | "finished" | "running" | "paused" | "waiting" | "other";

export function stepState(t: TaskRow, running: Set<string>): StepState {
  if (t.status === "done") return "done";
  if (running.has(t.id) || t.running) return "running";
  if (t.status === "in_review") return "finished";
  if (t.status === "in_progress") return "paused";
  if (t.status === "not_started") return "waiting";
  return "other";
}

const isLive = (t: TaskRow, running: Set<string>) => running.has(t.id) || !!t.running;

/**
 * Finished every step and waiting for the review: some step In review, every
 * step In review / done / cancelled, no turn live. Mirrors lib/store.ts
 * CHAIN_AWAITS_REVIEW, which feeds the server's awaiting_count.
 */
export function chainAwaitsReview(steps: TaskRow[], running: Set<string>): boolean {
  return (
    steps.some((s) => s.status === "in_review") &&
    steps.every((s) => !isLive(s, running) && (s.status === "in_review" || s.status === "done" || s.status === "cancelled"))
  );
}

/** A paused step's reason in words: the runner's recorded one, or a live ask. */
export function stepPauseReason(t: TaskRow): string {
  if (t.status !== "in_progress" || !t.awaiting_input) return "";
  return t.step_pause || (t.running ? "Waiting on your answer" : "Waiting on you");
}

/**
 * The chains worth a card: auto-advance chains where some step reached In
 * review (or already merged) or paused on the user, and not every step is
 * finished for good (done/cancelled).
 * Ordered by their first step's position in the list.
 */
export function chainsForReview(tasks: TaskRow[], running: Set<string>): ChainSummary[] {
  const byChain = new Map<string, TaskRow[]>();
  for (const t of tasks) {
    if (!t.chain_id || t.chain_mode !== AUTO_ADVANCE_MODE) continue;
    const list = byChain.get(t.chain_id) ?? [];
    list.push(t);
    byChain.set(t.chain_id, list);
  }
  const out: ChainSummary[] = [];
  for (const [id, steps] of byChain) {
    steps.sort((a, b) => (a.chain_pos ?? 0) - (b.chain_pos ?? 0));
    // Shown from the first In review step on — and kept after a partial merge
    // (some steps done) even while no step happens to be In review.
    const pausedStep = steps.find((s) => !!stepPauseReason(s)) ?? null;
    if (!pausedStep && !steps.some((s) => s.status === "in_review" || s.status === "done")) continue;
    if (steps.every((s) => s.status === "done" || s.status === "cancelled")) continue;
    const states = steps.map((s) => stepState(s, running));
    const count = (st: StepState) => states.filter((x) => x === st).length;
    out.push({
      id, steps, total: steps.length,
      finished: count("finished"), done: count("done"), running: count("running"), paused: count("paused"), waiting: count("waiting"),
      pausedStep, pauseReason: pausedStep ? stepPauseReason(pausedStep) : "", awaitsReview: chainAwaitsReview(steps, running),
    });
  }
  return out;
}

/** "2 of 4 finished · 1 running · 1 paused" — the card's one-line progress. */
export function chainProgressLabel(c: ChainSummary): string {
  const parts = [`${c.finished + c.done} of ${c.total} finished`];
  if (c.done) parts.push(`${c.done} done`);
  if (c.running) parts.push(`${c.running} running`);
  if (c.paused) parts.push(`${c.paused} paused`);
  if (c.waiting) parts.push(`${c.waiting} waiting`);
  return parts.join(" · ");
}

/** How many of these tasks' chains are waiting for their review (the "need you" pill's chain share). */
export function countChainsAwaitingReview(tasks: TaskRow[], running: Set<string>): number {
  return chainsForReview(tasks, running).filter((c) => c.awaitsReview).length;
}
