import { getTask, countAwaiting } from "@/lib/store";
import { subscribeGlobal } from "@/lib/events";
import { sseOpened, sseClosed } from "@/lib/idle";
import type { GlobalTaskEvent, TaskStreamEvent } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Which raw bus events mark a coarse lifecycle boundary. Everything else
// (assistant text, tool calls, usage, …) is per-transcript detail that only
// the task's own /messages stream cares about.
//
// `user` fires the moment a turn launches (running=1 is already persisted);
// `session` re-fires turn_started once the agent session actually opens,
// because that's when status flips to in_progress. Both map to the same
// coarse event — the payload is a snapshot, so replays are idempotent.
function coarse(ev: TaskStreamEvent): GlobalTaskEvent["event"] | null {
  switch (ev.type) {
    case "user":
    case "session":
      return "turn_started";
    case "ask":
      return "awaiting_input";
    case "ask_answered":
      return "ask_answered";
    case "suggested":
      return "suggested";
    case "turn_end":
      return "turn_end";
    default:
      return null;
  }
}

/**
 * The global task-lifecycle stream: one always-open SSE connection per client
 * tab, broadcasting coarse turn boundaries for EVERY task across EVERY project
 * — turn started, parked on a question, question answered, suggestion created,
 * turn ended. It's what keeps the task list's spinners, the project rail's
 * "needs you" badges, and the titlebar pill live for tasks whose transcript
 * stream isn't open (only the SELECTED task has one), replacing the old
 * 10-second task-list poll.
 *
 * Each event is built by re-reading the task row at publish time: the runner
 * persists running/awaiting_input/status BEFORE it publishes, so the snapshot
 * the client applies is authoritative, and replays/reconnect overlaps are
 * idempotent. There is deliberately no snapshot-on-connect — the client owns
 * its lists via the REST endpoints and refetches them on reconnect (events
 * missed while disconnected are gone; this stream is a live tail only).
 */
export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const unsub = subscribeGlobal((taskId, ev) => {
        const event = coarse(ev);
        if (!event) return;
        // Task deleted mid-turn (rows are hard-deleted) — nothing to report.
        const t = getTask(taskId);
        if (!t) return;
        const payload: GlobalTaskEvent = {
          type: "task",
          event,
          taskId,
          projectId: t.project_id,
          running: !!t.running,
          awaiting_input: !!t.awaiting_input,
          status: t.status,
          awaiting_count: countAwaiting(t.project_id),
        };
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          cleanup();
        }
      });
      // Keep-alive comment so proxies don't reap quiet streams, and so a dead
      // client is detected (enqueue throws) even when nothing is running.
      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          cleanup();
        }
      }, 25_000);
      sseOpened();
      let done = false;
      cleanup = () => {
        if (done) return;
        done = true;
        sseClosed();
        unsub();
        clearInterval(ping);
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      // Open the stream promptly so EventSource fires onopen (the client's
      // reconnect-resync hook) without waiting for the first real event.
      controller.enqueue(encoder.encode(`: connected\n\n`));
      req.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
