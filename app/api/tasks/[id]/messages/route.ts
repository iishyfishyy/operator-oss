import fs from "node:fs";
import { getTask, getProject, updateTask, addMessage, listMessages, listPendingMessages, addPendingMessage } from "@/lib/store";
import { startTurn, startResumeTurn } from "@/lib/runner";
import { claimTurn, hasTurn, unregisterTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";
import { subscribe, publish } from "@/lib/events";
import { sseOpened, sseClosed } from "@/lib/idle";
import { ensureWorktree } from "@/lib/git";
import { MAX_MESSAGE_CHARS } from "@/lib/promptLimits";
import type { TaskStreamEvent } from "@/lib/types";

const TOO_LARGE = `Message too large (over ${Math.floor(MAX_MESSAGE_CHARS / 1024)} KB). Paste big text as an attachment instead — it'll be saved as a file and read on demand, keeping it out of the prompt.`;

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Start a turn. The turn itself runs in a detached server-side runner
 * (lib/runner.ts) — this returns as soon as it's launched, so a page reload,
 * laptop sleep, or dropped connection never kills a running turn. Watch it via
 * GET on this same route (SSE), stop it explicitly via /abort.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  const project = getProject(task.project_id);
  if (!project) return new Response(JSON.stringify({ error: "no project" }), { status: 400 });
  if (!project.repo_path.trim()) {
    return new Response(
      JSON.stringify({ error: "Set this project's working directory (⚙ project context) before starting a task." }),
      { status: 400 }
    );
  }
  const { text } = await req.json();

  // Atomically claim the task's turn slot (the in-process abort registry is
  // the liveness source of truth — task.running can be stale after a crash).
  // claimTurn is a synchronous check+register: null means a turn is already
  // streaming, so park the follow-up instead of rejecting it — it renders as
  // "queued" and the runner dequeues it as the next turn when the current one
  // ends. A controller means WE own the launch: any concurrent POST from here
  // on sees the claim and queues, closing the old check-then-start race (two
  // turns on one session, with Stop only able to reach the second).
  const controller = claimTurn(id);
  if (!controller) {
    const content = String(text ?? "").trim();
    if (!content) return new Response(JSON.stringify({ error: "empty message" }), { status: 400 });
    if (content.length > MAX_MESSAGE_CHARS) return new Response(JSON.stringify({ error: TOO_LARGE }), { status: 413 });
    const pm = addPendingMessage(id, task.generation, content);
    publish(id, { type: "queued", msgId: pm.id, content, generation: task.generation });
    return new Response(JSON.stringify({ ok: true, queued: true }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  }
  let launched = false;
  try {
    // Ensure the working directory exists — Claude can't launch with a missing cwd.
    // Creating it supports greenfield projects (a brand-new app in a fresh folder).
    try {
      fs.mkdirSync(project.repo_path, { recursive: true });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: `Can't use working directory ${project.repo_path}: ${err instanceof Error ? err.message : String(err)}` }),
        { status: 400 }
      );
    }

    // The launch runs under the per-task lock shared with the merge/sync/complete
    // routes: those rewrite the worktree with multi-second git operations, and a
    // turn starting mid-commit would hand the agent a worktree being staged (and
    // hand the merge the agent's half-written files). We already hold the turn
    // slot (the claim above), so a merge that was waiting on us sees hasTurn()
    // and 409s; a merge that held the lock first finishes its commit before we
    // launch. `await` so the finally below can't release the claim early.
    return await withTaskLock(id, async () => {
      // Re-read under the lock — the task may have moved while we waited (a
      // merge advancing base_sha, a /clear bumping the generation, a delete).
      // No hasTurn re-check is needed here: the claim above owns the slot
      // atomically, so no other turn can have launched in the meantime.
      const fresh = getTask(id);
      if (!fresh) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });

      const isInitial = !fresh.started;
      // The very first turn's prompt is the title + description.
      const userText = isInitial
        ? `${fresh.title}\n\n${fresh.description}`.trim()
        : String(text ?? "").trim();
      if (!userText) return new Response(JSON.stringify({ error: "empty message" }), { status: 400 });
      if (userText.length > MAX_MESSAGE_CHARS) return new Response(JSON.stringify({ error: TOO_LARGE }), { status: 413 });

      // Give the task its own git worktree + branch so parallel tasks in the same
      // repo never collide. This runs on the first turn, but also self-heals a task
      // whose worktree is missing on disk — e.g. one that was reopened after its
      // merged worktree was pruned to reclaim disk. ensureWorktree reattaches to the
      // surviving branch when it still exists, so the old work is restored. Non-git/
      // empty repos fall back to running directly in repo_path (worktree_path stays
      // ""). Best-effort: a git hiccup must not block the run. Mutating `fresh` so the
      // runner uses the new cwd. Safe to await while holding the claim: that's the
      // point — a second POST landing in this window queues instead of double-running.
      if (!fresh.worktree_path || !fs.existsSync(fresh.worktree_path)) {
        try {
          const wt = await ensureWorktree(project.repo_path, fresh.id);
          if (wt) {
            fresh.worktree_path = wt.path;
            fresh.work_branch = wt.branch;
            fresh.base_sha = wt.baseSha;
            updateTask(id, { worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha });
          }
        } catch {
          // fall back to repo_path
        }
      }

      const gen = fresh.generation;
      if (isInitial) {
        const userMsg = addMessage(id, gen, "user", `**${fresh.title}** — ${fresh.description}`);
        // Mark running immediately, but defer `started` until Claude actually opens
        // a session — so a failed launch leaves the task cleanly retryable.
        updateTask(id, { running: 1, suggested: 0, awaiting_input: 0 });
        // Echo the user message to every open stream of this task (other viewers,
        // and the sender itself — the client renders from events, not optimistically).
        publish(id, { type: "user", content: userMsg.content, msgId: userMsg.id, generation: gen });
        startTurn(fresh, project, userText, "", controller);
      } else {
        // Resume: catch the worktree up, persist + echo the message, then hand off
        // to the detached runner. Same path the queue drainer uses.
        await startResumeTurn(fresh, project, userText, controller);
      }
      // The runner owns the claim now; its finally releases (or hands off) the slot.
      launched = true;
      return new Response(JSON.stringify({ ok: true, generation: gen }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    });
  } finally {
    // Every non-launch exit (bad working dir, missing task, empty/oversized
    // message, a throw before the runner took over) must free the claim, or the
    // task would read "running" forever and every future message would queue
    // into the void.
    if (!launched) unregisterTurn(id, controller);
  }
}

/**
 * Watch a task's transcript as SSE: first a `snapshot` event replaying the
 * persisted messages from SQLite, then a live tail of turn events via the
 * in-process bus. Reconnect-safe (each connect re-snapshots, events carry DB
 * message ids so clients upsert) and fan-out-safe (any number of viewers).
 * Closing this stream never touches the turn — Stop is the /abort route.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (e: TaskStreamEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      // Subscribe before snapshotting; both are synchronous (better-sqlite3),
      // so no event can fall between the snapshot and the tail.
      const unsub = subscribe(id, (ev) => {
        try {
          send(ev);
        } catch {
          cleanup();
        }
      });
      // Keep-alive comment so proxies don't reap quiet streams, and so a dead
      // client is detected (enqueue throws) even when the task is idle.
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
      send({ type: "snapshot", messages: listMessages(id), pending: listPendingMessages(id), running: hasTurn(id) });
      req.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      // Viewer went away (reload, sleep, tab close). Just detach — the turn,
      // if any, keeps running in lib/runner.ts.
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
