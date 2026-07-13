// Per-task exclusive async lock coupling "a turn is launching" to "a git
// operation is rewriting the worktree".
//
// Why: the merge/sync/complete routes used to check task.running once and then
// run multi-second git operations (git add -A + commit over the whole
// worktree). A POST /messages landing in that window could flip running=1 and
// launch the SDK agent, which writes into the SAME worktree while the merge is
// staging — committing (and potentially landing into the base branch)
// half-written files. The check and the git op were not atomic.
//
// The fix: both sides run under this lock. A merge/sync holds it for the whole
// git operation and re-checks hasTurn() once inside; a turn launch holds it
// through registerTurn() (so by the time it releases, hasTurn() is true and a
// waiting merge will 409). The lock is NOT held while a turn streams — a live
// turn is excluded by the hasTurn() re-check, not by lock tenure, so merges
// fail fast with 409 instead of queueing for minutes behind an agent.
//
// Kept on globalThis so dev HMR module reloads don't fork the lock table
// (same pattern as lib/events.ts / lib/abort.ts). Single Node process; no
// cross-process story needed.

declare global {
  // eslint-disable-next-line no-var
  var __orchTaskLocks: Map<string, Promise<void>> | undefined;
}

function locks(): Map<string, Promise<void>> {
  if (!global.__orchTaskLocks) global.__orchTaskLocks = new Map();
  return global.__orchTaskLocks;
}

/**
 * Run `fn` holding the exclusive per-task lock. Waiters queue FIFO behind the
 * current holder, so whatever state check `fn` performs first is atomic with
 * the work that follows it. Rethrows `fn`'s error; always releases.
 */
export async function withTaskLock<T>(taskId: string, fn: () => Promise<T> | T): Promise<T> {
  const map = locks();
  const prev = map.get(taskId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r)); // executor runs synchronously
  const tail = prev.then(() => gate);
  map.set(taskId, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Last one out drops the entry so idle tasks don't accumulate in the map.
    if (map.get(taskId) === tail) map.delete(taskId);
  }
}

/** Whether anyone currently holds (or is queued on) this task's lock. */
export function isTaskLocked(taskId: string): boolean {
  return locks().has(taskId);
}
