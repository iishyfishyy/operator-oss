// In-process registry of pending AskUserQuestion prompts.
//
// When Claude calls AskUserQuestion, a PreToolUse hook (lib/agents/claude/driver.ts) parks
// here awaiting the user's answer; the /answer route resolves it and the
// held-open turn continues with the answer as the tool result. Single Node
// process, so an in-memory map is enough — kept on globalThis so it survives
// dev HMR module reloads (same pattern as lib/abort.ts).

import type { AskQuestion, AskAnswers } from "./types";

interface PendingAsk {
  id: string; // the AskUserQuestion tool_use id
  questions: AskQuestion[];
  resolve: (answers: AskAnswers) => void;
  reject: (err: Error) => void;
}

declare global {
  // eslint-disable-next-line no-var
  var __orchAsks: Map<string, Map<string, PendingAsk>> | undefined;
}

// taskId → (askId → pending). A task can have several asks parked at once:
// one assistant message may carry multiple AskUserQuestion tool_uses, and the
// SDK fires the PreToolUse hook for each. Keying by ask id keeps every hook's
// promise resolvable — a flat one-per-task entry would orphan all but the
// latest, deadlocking the turn until the hook timeout.
function registry(): Map<string, Map<string, PendingAsk>> {
  if (!global.__orchAsks) global.__orchAsks = new Map();
  return global.__orchAsks;
}

function remove(taskId: string, askId: string): PendingAsk | undefined {
  const byAsk = registry().get(taskId);
  const pending = byAsk?.get(askId);
  if (!byAsk || !pending) return undefined;
  byAsk.delete(askId);
  if (byAsk.size === 0) registry().delete(taskId);
  return pending;
}

/**
 * Park until the user answers this question (or `signal` aborts — the explicit
 * Stop button; turns are detached from connections, so a page reload or dropped
 * stream leaves the ask parked and answerable). Resolves with the chosen
 * answers; rejects if the turn is torn down while waiting.
 */
export function waitForAnswer(
  taskId: string,
  id: string,
  questions: AskQuestion[],
  signal?: AbortSignal
): Promise<AskAnswers> {
  return new Promise<AskAnswers>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    let byAsk = registry().get(taskId);
    if (!byAsk) {
      byAsk = new Map();
      registry().set(taskId, byAsk);
    }
    // An ask id should be unique per tool_use; if one collides (e.g. a hook
    // retry), settle the old promise instead of orphaning it.
    byAsk.get(id)?.reject(new Error("superseded"));
    byAsk.set(id, { id, questions, resolve, reject });
    signal?.addEventListener(
      "abort",
      () => {
        // Every pending ask for the turn registers its own listener on the
        // turn's signal, so a single abort rejects them all.
        remove(taskId, id);
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}

/**
 * Resolve a parked ask with the user's answers. Returns false when nothing is
 * waiting under that id (e.g. the turn was torn down by a page reload) — the
 * caller then falls back to resuming the session with the answer as a normal
 * reply.
 */
export function submitAnswer(taskId: string, id: string, answers: AskAnswers): boolean {
  const pending = remove(taskId, id);
  if (!pending) return false;
  pending.resolve(answers);
  return true;
}

// ---------- ask outcomes (the ask_user MCP bridge's poll target) ----------
//
// The Claude driver delivers an answered ask back to the model in-process (the
// PreToolUse hook returns it as the tool result). The stdio MCP bridge can't
// hold a promise across processes, so it POLLS instead: startAskUser
// (lib/agentTools.ts) settles the outcome here when the user answers (or the
// turn is torn down), and the bridge's wait endpoint takes it exactly once.
// Same globalThis pattern as the pending-ask registry above.

declare global {
  // eslint-disable-next-line no-var
  var __orchAskOutcomes: Map<string, string> | undefined;
}

function outcomes(): Map<string, string> {
  if (!global.__orchAskOutcomes) global.__orchAskOutcomes = new Map();
  return global.__orchAskOutcomes;
}

/** Record the final text of an ask (the formatted answers, or a dismissal note). */
export function settleAsk(taskId: string, id: string, text: string): void {
  outcomes().set(`${taskId}:${id}`, text);
}

/** Take (and clear) an ask's settled outcome; null while still unanswered. */
export function takeAskOutcome(taskId: string, id: string): string | null {
  const key = `${taskId}:${id}`;
  const text = outcomes().get(key);
  if (text === undefined) return null;
  outcomes().delete(key);
  return text;
}
