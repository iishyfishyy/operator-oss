// Per-repo async mutex. Git mutations of a project's SHARED main working tree
// (checkouts, in-tree merges, worktree add/remove) are not safe to run
// concurrently: two merges in the same repo race the HEAD/index and can strand
// the repo on the wrong branch or leave it stuck mid-merge. This serializes them
// per repoPath so only one main-tree mutation runs at a time.
//
// Single Node process, so an in-memory promise chain is enough — kept on
// globalThis so it survives dev HMR module reloads (same pattern as
// lib/events.ts, lib/abort.ts, lib/asks.ts).

declare global {
  // eslint-disable-next-line no-var
  var __orchRepoLocks: Map<string, Promise<unknown>> | undefined;
}

function locks(): Map<string, Promise<unknown>> {
  if (!global.__orchRepoLocks) global.__orchRepoLocks = new Map();
  return global.__orchRepoLocks;
}

/**
 * Run `fn` with exclusive access to `key` (a repo path). Calls for the same key
 * queue and run one at a time, in arrival order; different keys never block each
 * other. `fn`'s result (or rejection) is returned to its own caller — a failing
 * critical section never poisons the ones waiting behind it.
 */
export async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const reg = locks();
  const prev = reg.get(key) ?? Promise.resolve();
  // Chain fn after whatever holds the lock, regardless of how that settled.
  const run = prev.then(fn, fn);
  // The tail others wait on is settle-only, so a rejection here doesn't reject
  // the next waiter's `prev`.
  const tail = run.then(
    () => {},
    () => {}
  );
  reg.set(key, tail);
  // Drop the entry once we're the last in line, so the map doesn't grow forever.
  tail.then(() => {
    if (reg.get(key) === tail) reg.delete(key);
  });
  return run;
}
