// The "needs you" surfaces must never disagree: the titlebar pill count
// (countAwaiting, carried on /api/events payloads), its dropdown (listNeedsYou),
// and the project badges (listProjects' awaiting_count subquery) all share one
// predicate in lib/store.ts. The regression this pins: listNeedsYou used to add
// `running = 0`, so a turn parked mid-stream on an AskUserQuestion (running=1 +
// awaiting_input=1) showed a red pill count while the dropdown said nothing
// needed you. Also pinned: the three mutation routes that used to settle or
// delete a task silently (status PATCH, /clear, DELETE) now publish on the bus,
// and GET /api/events relays a deletion even though the row is gone.
import { describe, it, expect } from "vitest";
import {
  createProject, createTask, updateTask, getTask, deleteTask, addMessage,
  listProjects, listNeedsYou, countAwaiting, isTaskAwaiting, markTaskViewed,
} from "@/lib/store";
import { getDb, migrate } from "@/lib/db";
import { subscribeGlobal, publishGlobal, type BusEvent } from "@/lib/events";
import { PATCH as patchTask, DELETE as deleteTaskRoute } from "@/app/api/tasks/[id]/route";
import { POST as clearRoute } from "@/app/api/tasks/[id]/clear/route";
import { POST as viewRoute } from "@/app/api/tasks/[id]/view/route";
import { GET as eventsRoute } from "@/app/api/events/route";
import type { Status } from "@/lib/types";

// Collect every bus event published for one task while `fn` runs.
async function busEventsFor(taskId: string, fn: () => Promise<unknown>): Promise<BusEvent[]> {
  const seen: BusEvent[] = [];
  const unsub = subscribeGlobal((tid, ev) => { if (tid === taskId) seen.push(ev); });
  try {
    await fn();
  } finally {
    unsub();
  }
  return seen;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

// Directly stamp a row's last_viewed_at so tests can order it around a message
// timestamp precisely (Date.now() ties are otherwise possible on fast machines).
function stampViewed(taskId: string, at: number) {
  getDb().prepare("UPDATE tasks SET last_viewed_at = ? WHERE id = ?").run(at, taskId);
}
function stampMessageAt(msgId: string, at: number) {
  getDb().prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(at, msgId);
}

describe("the shared needs-you predicate", () => {
  it("countAwaiting, listNeedsYou and listProjects agree across the full state × viewed matrix", () => {
    const project = createProject({ name: "NeedsMatrix" });
    const statuses: Status[] = ["not_started", "in_progress", "on_hold", "done", "cancelled"];
    // Every 'awaiting' row gets one assistant message so last_agent_activity > 0
    // — the read-tracking clause has something to compare last_viewed_at
    // against. Without it every derived value would be 0 > 0 = false, so the
    // matrix would collapse to just the running-parked cases.
    const AGENT_AT = 1_000_000; // any fixed timestamp; well below Date.now()
    const parkedViewed: string[] = []; // the running=1 + awaiting=1 rows that ARE viewed — must still count
    const settledUnviewed: string[] = []; // running=0 + awaiting=1 rows unviewed — must count
    const settledViewed: string[] = []; // running=0 + awaiting=1 rows viewed AFTER activity — must NOT count
    for (const status of statuses)
      for (const running of [0, 1])
        for (const awaiting of [0, 1])
          for (const suggested of [0, 1])
            for (const viewed of [0, 1]) {
              const t = createTask({
                project_id: project.id,
                title: `${status}/r${running}/a${awaiting}/s${suggested}/v${viewed}`,
                suggested: !!suggested,
              });
              updateTask(t.id, { status, running, awaiting_input: awaiting });
              if (awaiting === 1) {
                const m = addMessage(t.id, 1, "assistant", "agent said something");
                stampMessageAt(m.id, AGENT_AT);
              }
              if (viewed === 1) stampViewed(t.id, AGENT_AT + 1); // read AFTER the message
              if (status === "in_progress" && awaiting === 1 && suggested === 0) {
                if (running === 1 && viewed === 1) parkedViewed.push(t.id);
                if (running === 0 && viewed === 0) settledUnviewed.push(t.id);
                if (running === 0 && viewed === 1) settledViewed.push(t.id);
              }
            }

    // 4 rows count out of the 80: (running∈{0,1}) × (viewed∈{0,1}), except the
    // settled+viewed row clears — so 3. running-parked (both viewed values) plus
    // the unviewed settled row.
    const n = countAwaiting(project.id);
    expect(n).toBe(3);

    // Dropdown rows and pill count agree, and include the parked-ask-viewed row
    // (an unanswered ask needs the user regardless of viewing).
    const dropdown = listNeedsYou().filter((r) => r.project_id === project.id);
    expect(dropdown).toHaveLength(n);
    expect(dropdown.map((r) => r.id)).toContain(parkedViewed[0]);
    expect(dropdown.map((r) => r.id)).toContain(settledUnviewed[0]);
    // …and the settled+viewed row is gone.
    expect(dropdown.map((r) => r.id)).not.toContain(settledViewed[0]);

    // Project badge subquery agrees, and the per-row derived helper agrees too.
    expect(listProjects().find((p) => p.id === project.id)!.awaiting_count).toBe(n);
    expect(isTaskAwaiting(parkedViewed[0])).toBe(true);
    expect(isTaskAwaiting(settledUnviewed[0])).toBe(true);
    expect(isTaskAwaiting(settledViewed[0])).toBe(false);
  });

  it("new agent activity after a view re-arms the badge", () => {
    const project = createProject({ name: "Rearm" });
    const t = createTask({ project_id: project.id, title: "T" });
    updateTask(t.id, { status: "in_progress", awaiting_input: 1 });
    const first = addMessage(t.id, 1, "assistant", "first message");
    stampMessageAt(first.id, 1_000_000);
    // Read.
    stampViewed(t.id, 1_000_050);
    expect(isTaskAwaiting(t.id)).toBe(false);
    // Fresh agent activity postdates the view → back to awaiting.
    const second = addMessage(t.id, 1, "assistant", "another turn ended");
    stampMessageAt(second.id, 2_000_000);
    expect(isTaskAwaiting(t.id)).toBe(true);
  });

  it("user messages don't re-arm the badge (only assistant/tool/system count)", () => {
    const project = createProject({ name: "UserMsgs" });
    const t = createTask({ project_id: project.id, title: "T" });
    updateTask(t.id, { status: "in_progress", awaiting_input: 1 });
    const agent = addMessage(t.id, 1, "assistant", "agent");
    stampMessageAt(agent.id, 1_000_000);
    stampViewed(t.id, 1_000_050);
    // The user answering / typing shouldn't reopen "waiting on you".
    const user = addMessage(t.id, 1, "user", "reply");
    stampMessageAt(user.id, 2_000_000);
    expect(isTaskAwaiting(t.id)).toBe(false);
  });
});

describe("POST /api/tasks/[id]/view", () => {
  it("stamps last_viewed_at, clears the derived badge, and publishes task_updated", async () => {
    const project = createProject({ name: "ViewRoute" });
    const t = createTask({ project_id: project.id, title: "T" });
    updateTask(t.id, { status: "in_progress", awaiting_input: 1 });
    const m = addMessage(t.id, 1, "assistant", "hi");
    stampMessageAt(m.id, 1_000_000);
    expect(isTaskAwaiting(t.id)).toBe(true);

    const seen = await busEventsFor(t.id, async () => {
      const res = await viewRoute(new Request("http://test/view", { method: "POST" }), params(t.id));
      expect(res.status).toBe(200);
    });

    const row = getTask(t.id)!;
    expect(row.last_viewed_at).toBeGreaterThan(0);
    expect(row.awaiting_input).toBe(1); // raw column untouched
    expect(isTaskAwaiting(t.id)).toBe(false); // derived flips
    expect(seen).toContainEqual({ type: "task_updated" });
  });

  it("does not clear a parked ask — running=1 stays awaiting even after view", async () => {
    const project = createProject({ name: "ParkedView" });
    const t = createTask({ project_id: project.id, title: "T" });
    updateTask(t.id, { status: "in_progress", awaiting_input: 1, running: 1 }); // parked ask
    const m = addMessage(t.id, 1, "assistant", "here's the ask");
    stampMessageAt(m.id, 1_000_000);

    await viewRoute(new Request("http://test/view", { method: "POST" }), params(t.id));

    // The stamp landed…
    expect(getTask(t.id)!.last_viewed_at).toBeGreaterThan(0);
    // …but the running=1 short-circuit keeps the row counted.
    expect(isTaskAwaiting(t.id)).toBe(true);
    expect(countAwaiting(project.id)).toBe(1);
  });

  it("404s on an unknown task", async () => {
    const res = await viewRoute(new Request("http://test/view", { method: "POST" }), params("nope"));
    expect(res.status).toBe(404);
  });
});

describe("last_viewed_at migration", () => {
  it("is idempotent: re-running migrate() on an up-to-date schema is a no-op", () => {
    const db = getDb();
    // Baseline column presence.
    const cols = () => (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
    expect(cols()).toContain("last_viewed_at");
    // Should not throw and should not add a duplicate column.
    expect(() => { migrate(db); migrate(db); }).not.toThrow();
    expect(cols().filter((n) => n === "last_viewed_at")).toHaveLength(1);
  });

  it("backfills existing rows to 0 (never viewed) so upgraded instances show as awaiting on next activity", () => {
    const project = createProject({ name: "MigrateBackfill" });
    const t = createTask({ project_id: project.id, title: "Existing" });
    // The default: a fresh row is unread until POST /view stamps it.
    expect(getTask(t.id)!.last_viewed_at).toBe(0);
    // With last_viewed_at=0 and an agent message at any time > 0, the row shows as awaiting.
    updateTask(t.id, { status: "in_progress", awaiting_input: 1 });
    const m = addMessage(t.id, 1, "assistant", "hi");
    stampMessageAt(m.id, 1);
    expect(isTaskAwaiting(t.id)).toBe(true);
  });
});

describe("mutation routes publish lifecycle events", () => {
  it("a manual status PATCH publishes task_updated (a plain field edit does not)", async () => {
    const project = createProject({ name: "PatchPub" });
    const t = createTask({ project_id: project.id, title: "T" });
    updateTask(t.id, { status: "in_progress", awaiting_input: 1 });

    const seen = await busEventsFor(t.id, async () => {
      const res = await patchTask(
        new Request("http://test", { method: "PATCH", body: JSON.stringify({ status: "done" }) }),
        params(t.id)
      );
      expect(res.status).toBe(200);
    });
    expect(getTask(t.id)).toMatchObject({ status: "done", awaiting_input: 0 });
    expect(seen).toContainEqual({ type: "task_updated" });
    expect(countAwaiting(project.id)).toBe(0);

    // A non-status edit changes nothing awaiting-related — no event.
    const quiet = await busEventsFor(t.id, async () => {
      await patchTask(new Request("http://test", { method: "PATCH", body: JSON.stringify({ title: "renamed" }) }), params(t.id));
    });
    expect(quiet).toEqual([]);
  });

  it("/clear publishes task_updated after settling the row", async () => {
    const project = createProject({ name: "ClearPub" });
    const t = createTask({ project_id: project.id, title: "T" });
    updateTask(t.id, { status: "in_progress", awaiting_input: 1, started: 1 });

    const seen = await busEventsFor(t.id, async () => {
      const res = await clearRoute(new Request("http://test/clear", { method: "POST" }), params(t.id));
      expect(res.status).toBe(200);
    });
    // Row settled first (the /api/events payload re-reads it), then announced.
    expect(getTask(t.id)).toMatchObject({ generation: 2, running: 0, awaiting_input: 0, status: "in_progress" });
    expect(seen).toContainEqual({ type: "task_updated" });
  });

  it("DELETE publishes task_deleted AFTER the row is gone, with the recomputed count", async () => {
    const project = createProject({ name: "DelPub" });
    const t = createTask({ project_id: project.id, title: "Doomed" });
    updateTask(t.id, { status: "in_progress", awaiting_input: 1, running: 1 }); // parked on an ask
    const other = createTask({ project_id: project.id, title: "Still waiting" });
    updateTask(other.id, { status: "in_progress", awaiting_input: 1 });
    // Give `other` some agent activity so the read-tracking clause counts it
    // (an untouched row with no messages has last_agent_activity = 0 and would
    // fall out — see the state × viewed matrix test above).
    addMessage(other.id, 1, "assistant", "waiting on you");
    expect(countAwaiting(project.id)).toBe(2);

    const rowGoneAtPublish: boolean[] = [];
    const unsub = subscribeGlobal((tid, ev) => {
      if (tid === t.id && ev.type === "task_deleted") rowGoneAtPublish.push(!getTask(t.id));
    });
    const seen = await busEventsFor(t.id, async () => {
      const res = await deleteTaskRoute(new Request("http://test", { method: "DELETE" }), params(t.id));
      expect(res.status).toBe(200);
    });
    unsub();

    expect(seen).toContainEqual({ type: "task_deleted", projectId: project.id, awaiting_count: 1 });
    expect(rowGoneAtPublish).toEqual([true]); // published after the hard delete
  });
});

describe("GET /api/events wire relay", () => {
  it("relays task_updated as a coarse task snapshot and task_deleted without a row to re-read", async () => {
    const project = createProject({ name: "WireRelay" });
    const t = createTask({ project_id: project.id, title: "T" });
    updateTask(t.id, { status: "in_progress", awaiting_input: 1, running: 1 });

    const ac = new AbortController();
    const res = await eventsRoute(new Request("http://test/api/events", { signal: ac.signal }));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // Next `data:` frame off the stream, skipping comments/keep-alives.
    const nextData = async (): Promise<unknown> => {
      for (;;) {
        const idx = buf.indexOf("\n\n");
        if (idx >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (frame.startsWith("data: ")) return JSON.parse(frame.slice(6));
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream closed before the expected frame");
        buf += decoder.decode(value);
      }
    };

    try {
      // A route settle on a live row → the usual re-read-the-task payload,
      // with the mid-turn ask park (running + awaiting) counted.
      publishGlobal(t.id, { type: "task_updated" });
      expect(await nextData()).toMatchObject({
        type: "task", event: "task_updated", taskId: t.id, projectId: project.id,
        running: true, awaiting_input: true, awaiting_count: 1,
      });

      // Deletion: the getTask bail can't apply — the event carries everything.
      deleteTask(t.id);
      publishGlobal(t.id, { type: "task_deleted", projectId: project.id, awaiting_count: 0 });
      expect(await nextData()).toEqual({ type: "task_deleted", taskId: t.id, projectId: project.id, awaiting_count: 0 });
    } finally {
      ac.abort();
    }
  });
});
