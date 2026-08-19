import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { init, migrate } from "../lib/db";

// The migration that seeds sessions.usage_cum for codex threads that already
// ran. Codex reports a thread's CUMULATIVE token counts on every turn.completed,
// so pre-upgrade usage rows are cumulative snapshots — the newest one is the
// baseline the next turn must subtract. Without it, the first turn after
// upgrading re-bills the whole thread one last time.

function preUpgradeDb() {
  const db = new Database(":memory:");
  init(db);
  // Roll the schema back to before the column existed.
  db.exec("ALTER TABLE sessions DROP COLUMN usage_cum");
  return db;
}

function seedThread(
  db: Database.Database,
  opts: { agent: string; threadId: string | null; usage: [number, number, number][] }
) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO projects (id, name, icon, sub, color, context, repo_path, branch, port, position, created_at)
     VALUES ('p1', 'P', 'P', '', '#C2603C', '', '', 'main', 0, 0, ?)`
  ).run(now);
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, description, priority, status, generation, created_at, updated_at, agent)
     VALUES ('t1', 'p1', 'T', '', 'med', 'in_progress', 1, ?, ?, ?)`
  ).run(now, now, opts.agent);
  db.prepare(
    `INSERT INTO sessions (id, project_id, task_id, generation, claude_session_id, started_at)
     VALUES ('s1', 'p1', 't1', 1, ?, ?)`
  ).run(opts.threadId, now);
  opts.usage.forEach(([input, cached, output], i) => {
    db.prepare(
      `INSERT INTO task_usage (id, project_id, task_id, generation, agent, cost_usd, input_tokens, output_tokens,
                               cache_read_tokens, cache_creation_tokens, created_at)
       VALUES (?, 'p1', 't1', 1, ?, 0, ?, ?, ?, 0, ?)`
    ).run(`u${i}`, opts.agent, input, output, cached, now + i);
  });
}

const cumOf = (db: Database.Database) =>
  (db.prepare("SELECT usage_cum FROM sessions WHERE id = 's1'").get() as { usage_cum: string | null }).usage_cum;

let open: Database.Database | undefined;
afterEach(() => open?.close());

describe("codex cumulative-usage baseline migration", () => {
  it("seeds the baseline from the newest cumulative row a codex thread recorded", () => {
    const db = (open = preUpgradeDb());
    seedThread(db, {
      agent: "codex",
      threadId: "thread-1",
      usage: [
        [14_000, 11_000, 500],
        [28_000, 22_000, 900],
      ],
    });

    migrate(db);

    expect(JSON.parse(cumOf(db)!)).toEqual({
      input: 28_000,
      cachedInput: 22_000,
      cacheWrite: 0,
      output: 900,
      reasoning: 0,
    });
  });

  it("leaves Claude threads (already per-turn) and thread-less sessions alone", () => {
    const db = (open = preUpgradeDb());
    seedThread(db, { agent: "claude", threadId: "sess-1", usage: [[100, 0, 10]] });
    migrate(db);
    expect(cumOf(db)).toBeNull();

    const db2 = new Database(":memory:");
    init(db2);
    db2.exec("ALTER TABLE sessions DROP COLUMN usage_cum");
    seedThread(db2, { agent: "codex", threadId: null, usage: [[100, 0, 10]] });
    migrate(db2);
    expect(cumOf(db2)).toBeNull();
    db2.close();
  });

  it("is a no-op on a DB that already has the column (no re-seeding over live baselines)", () => {
    const db = (open = preUpgradeDb());
    seedThread(db, { agent: "codex", threadId: "thread-1", usage: [[14_000, 11_000, 500]] });
    migrate(db);
    // A later turn advances the baseline; a restart must not roll it back to the
    // usage table's newest row.
    db.prepare("UPDATE sessions SET usage_cum = ? WHERE id = 's1'").run(
      JSON.stringify({ input: 90_000, cachedInput: 80_000, cacheWrite: 0, output: 3_000, reasoning: 0 })
    );
    migrate(db);
    expect(JSON.parse(cumOf(db)!).input).toBe(90_000);
  });
});
