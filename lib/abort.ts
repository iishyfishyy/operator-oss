// In-process registry of AbortControllers for actively streaming task turns.
// The messages route registers a controller when a turn starts; the abort route
// looks it up by task id and aborts it. Single Node process, so an in-memory map
// is enough — kept on globalThis so it survives dev HMR module reloads.

declare global {
  // eslint-disable-next-line no-var
  var __orchAbort: Map<string, AbortController> | undefined;
}

function registry(): Map<string, AbortController> {
  if (!global.__orchAbort) global.__orchAbort = new Map();
  return global.__orchAbort;
}

// Atomically claim the turn slot for a task: register a fresh controller and
// return it, or return null if a turn already occupies the slot. Check +
// register happen in one synchronous step — this is the guard against the
// launch TOCTOU where two concurrent POSTs both read hasTurn()===false across
// an await (worktree creation / sync) and started two turns on one session,
// with Stop only able to reach the second. Callers must either hand the
// controller to the runner (whose finally releases it) or release it
// themselves via unregisterTurn on every non-launch path.
export function claimTurn(taskId: string): AbortController | null {
  const reg = registry();
  if (reg.has(taskId)) return null;
  const controller = new AbortController();
  reg.set(taskId, controller);
  return controller;
}

// Atomically pass the slot from a finishing turn to its dequeued follow-up.
// Returns the follow-up's fresh controller, or null if `prev` no longer owns
// the slot (it was aborted, or a successor turn claimed it). Because the swap
// is synchronous, occupancy never lapses across the handoff — no POST can
// slip a parallel turn in between the two.
export function handoffTurn(taskId: string, prev: AbortController): AbortController | null {
  const reg = registry();
  if (reg.get(taskId) !== prev) return null;
  const controller = new AbortController();
  reg.set(taskId, controller);
  return controller;
}

// Whether `controller` is the current occupant of the task's slot. A finishing
// turn uses this to detect a successor (a turn started after this one was
// Stopped but before it unwound) so it doesn't clobber the successor's state.
export function ownsTurn(taskId: string, controller: AbortController): boolean {
  return registry().get(taskId) === controller;
}

// Low-level: force-register a controller, replacing any occupant. Production
// launch paths must use claimTurn/handoffTurn (atomic, never orphan a live
// controller); this exists for tests that stage the registry directly.
export function registerTurn(taskId: string, controller: AbortController): void {
  registry().set(taskId, controller);
}

// Drop the controller once the turn ends. Only clears the entry if it still
// points at this controller (so a newer turn's registration isn't wiped).
export function unregisterTurn(taskId: string, controller: AbortController): void {
  const reg = registry();
  if (reg.get(taskId) === controller) reg.delete(taskId);
}

// Whether a turn is live for this task right now. The registry is the source
// of truth for liveness — task.running in SQLite can be stale after a server
// restart mid-turn, but this map dies (and clears) with the process.
export function hasTurn(taskId: string): boolean {
  return registry().has(taskId);
}

// Number of turns live in this process right now (idleness signal).
export function activeTurnCount(): number {
  return registry().size;
}

// Signal abort for a task's active turn. Returns true if one was running.
export function abortTurn(taskId: string): boolean {
  const reg = registry();
  const controller = reg.get(taskId);
  if (!controller) return false;
  reg.delete(taskId);
  controller.abort();
  return true;
}
