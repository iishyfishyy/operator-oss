// In-process activity registry powering GET /api/instance/idle — the signals a
// control plane needs to decide when it's safe to `docker stop` this instance.
//
// Kept on globalThis (same pattern as lib/abort.ts / lib/events.ts) because
// server.js — plain Node, but the SAME process as the Next route handlers —
// writes two of the fields directly: it counts live /pty websockets and stamps
// lastRequestAt on every HTTP request / WS upgrade. Keep the field names in
// sync with server.js.

export type Activity = {
  /** Process boot (ms epoch). */
  startedAt: number;
  /** Last HTTP request or WS upgrade — excluding /api/instance/idle itself, so polling never looks like activity. */
  lastRequestAt: number;
  /** Live proxied /pty terminal websockets (maintained by server.js). */
  openPty: number;
  /** Live transcript SSE streams (maintained by the messages route). */
  openSse: number;
  /**
   * In-flight detached server-side work that isn't a task turn, pty, or SSE —
   * e.g. a background "Refresh with AI" draft. Counted as busy so the control
   * plane never `docker stop`s the container out from under it.
   */
  openWork: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __orchActivity: Activity | undefined;
}

export function activity(): Activity {
  if (!global.__orchActivity) {
    const now = Date.now();
    global.__orchActivity = { startedAt: now, lastRequestAt: now, openPty: 0, openSse: 0, openWork: 0 };
  }
  // Older processes may have a struct predating openWork; keep it defined.
  if (global.__orchActivity.openWork == null) global.__orchActivity.openWork = 0;
  return global.__orchActivity;
}

export function sseOpened(): void {
  activity().openSse++;
}

export function sseClosed(): void {
  const a = activity();
  a.openSse = Math.max(0, a.openSse - 1);
}

/** Mark a unit of detached background work as started (see openWork). */
export function workStarted(): void {
  activity().openWork++;
}

/** Mark a unit of detached background work as finished. */
export function workEnded(): void {
  const a = activity();
  a.openWork = Math.max(0, a.openWork - 1);
}
