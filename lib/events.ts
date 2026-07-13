// In-process pub/sub for live task turn events.
//
// The detached turn runner (lib/runner.ts) publishes every event it persists;
// any number of GET /messages SSE streams subscribe by task id and relay them
// to connected clients. Single Node process, so an in-memory map is enough —
// kept on globalThis so it survives dev HMR module reloads (same pattern as
// lib/abort.ts / lib/asks.ts).

import type { TaskStreamEvent } from "./types";

type Listener = (ev: TaskStreamEvent) => void;
type GlobalListener = (taskId: string, ev: TaskStreamEvent) => void;

declare global {
  // eslint-disable-next-line no-var
  var __orchEvents: Map<string, Set<Listener>> | undefined;
  // eslint-disable-next-line no-var
  var __orchEventsGlobal: Set<GlobalListener> | undefined;
}

function registry(): Map<string, Set<Listener>> {
  if (!global.__orchEvents) global.__orchEvents = new Map();
  return global.__orchEvents;
}

function globalRegistry(): Set<GlobalListener> {
  if (!global.__orchEventsGlobal) global.__orchEventsGlobal = new Set();
  return global.__orchEventsGlobal;
}

/** Subscribe to a task's live events. Returns an unsubscribe function. */
export function subscribe(taskId: string, fn: Listener): () => void {
  const reg = registry();
  let set = reg.get(taskId);
  if (!set) {
    set = new Set();
    reg.set(taskId, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) reg.delete(taskId);
  };
}

/**
 * Subscribe to EVERY task's events (the wildcard channel behind the global
 * GET /api/events lifecycle stream). Listeners get the task id alongside each
 * event, since the per-task keying is lost. Returns an unsubscribe function.
 */
export function subscribeGlobal(fn: GlobalListener): () => void {
  const set = globalRegistry();
  set.add(fn);
  return () => {
    set.delete(fn);
  };
}

/** Fan an event out to every subscriber of this task. Safe with zero listeners. */
export function publish(taskId: string, ev: TaskStreamEvent): void {
  const set = registry().get(taskId);
  if (set) {
    for (const fn of set) {
      try {
        fn(ev);
      } catch {
        // One dead subscriber (e.g. a stream torn down mid-enqueue) must never
        // break delivery to the others or the turn itself.
      }
    }
  }
  for (const fn of globalRegistry()) {
    try {
      fn(taskId, ev);
    } catch {
      // same rule as above
    }
  }
}
