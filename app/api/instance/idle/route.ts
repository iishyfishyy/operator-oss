import { getDb } from "@/lib/db";
import { activeTurnCount } from "@/lib/abort";
import { activity } from "@/lib/idle";

export const dynamic = "force-dynamic";

/**
 * Instance idleness report, for the control plane that sleeps idle containers
 * (`docker stop`) and wakes them on demand. Polling this endpoint does NOT
 * count as activity — server.js skips it when stamping lastRequestAt.
 *
 * `idle` means "stopping now loses nothing": no turn is executing and no
 * client holds a live connection (terminal websocket or transcript SSE).
 * `idleForMs` is how long since the last real request; the control plane
 * applies its own threshold on top (e.g. idle && idleForMs > 30min → stop).
 *
 * runningTurns (the in-process abort registry) is the liveness source of
 * truth; tasksMarkedRunning is the SQLite `running` flag, which can lag
 * briefly. tasksAwaitingInput is informational — those tasks are parked
 * waiting on the user, which is safe to stop.
 */
export async function GET() {
  const a = activity();
  const flags = getDb()
    .prepare(
      "SELECT COALESCE(SUM(running), 0) AS running, COALESCE(SUM(awaiting_input), 0) AS awaiting FROM tasks",
    )
    .get() as { running: number; awaiting: number };

  const runningTurns = activeTurnCount();
  const now = Date.now();
  const busy = runningTurns > 0 || a.openPty > 0 || a.openSse > 0 || a.openWork > 0;

  return Response.json({
    idle: !busy,
    now,
    startedAt: a.startedAt,
    lastRequestAt: a.lastRequestAt,
    idleForMs: busy ? 0 : now - a.lastRequestAt,
    openSse: a.openSse,
    openPty: a.openPty,
    openWork: a.openWork,
    runningTurns,
    tasksMarkedRunning: flags.running,
    tasksAwaitingInput: flags.awaiting,
  });
}
