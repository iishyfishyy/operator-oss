import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import path from "node:path";
import fs from "node:fs";
import { DB_DIR, PROJECTS_DIR, SERVICE_PORT_BASE } from "./config";
import { loadPersistedApiKey } from "./anthropic-key";
import { loadPersistedOpenAiKey } from "./openai-key";

// Single shared connection. Stored outside the repo (ORCH_DB_DIR, default
// ~/.zen-orchestrator) so `git clean`/re-clone can't wipe it.
const DB_PATH = path.join(DB_DIR, "orchestrator.db");

declare global {
  // eslint-disable-next-line no-var
  var __orchDb: Database.Database | undefined;
}

export function init(db: Database.Database) {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      icon        TEXT NOT NULL DEFAULT '',
      sub         TEXT NOT NULL DEFAULT '',
      color       TEXT NOT NULL DEFAULT '#C2603C',
      context     TEXT NOT NULL DEFAULT '',
      building    TEXT NOT NULL DEFAULT '',
      conventions TEXT NOT NULL DEFAULT '',
      repo_path   TEXT NOT NULL DEFAULT '',
      branch      TEXT NOT NULL DEFAULT 'main',
      -- Per-project managed services: the dev server command (long-running) plus
      -- optional one-shot setup/test commands, supervised by lib/services.ts.
      -- port is the project's stable, deterministic port (see lib/config.ts),
      -- injected as PORT into each service's env and the project's PTY shell.
      dev_command   TEXT NOT NULL DEFAULT '',
      setup_command TEXT NOT NULL DEFAULT '',
      test_command  TEXT NOT NULL DEFAULT '',
      port          INTEGER NOT NULL DEFAULT 0,
      -- Which agent driver new tasks in this project run under (lib/agents/).
      default_agent TEXT NOT NULL DEFAULT 'claude',
      position    INTEGER NOT NULL DEFAULT 0,
      deprecated  INTEGER NOT NULL DEFAULT 0,
      -- 1 for the built-in "Welcome" tutorial project so it's excluded from the
      -- "instance in use" onboarding check and can be surfaced with coach marks.
      seeded      INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      priority    TEXT NOT NULL DEFAULT 'med',
      status      TEXT NOT NULL DEFAULT 'not_started',
      suggested   INTEGER NOT NULL DEFAULT 0,
      -- The agent driver this task's sessions run under (lib/agents/registry.ts).
      agent       TEXT NOT NULL DEFAULT 'claude',
      model       TEXT,
      resolved_model TEXT,
      reasoning   TEXT,
      permission_mode TEXT,
      session_id  TEXT,
      worktree_path TEXT NOT NULL DEFAULT '',
      work_branch   TEXT NOT NULL DEFAULT '',
      base_sha      TEXT NOT NULL DEFAULT '',
      merged_at     INTEGER NOT NULL DEFAULT 0,
      generation  INTEGER NOT NULL DEFAULT 1,
      started     INTEGER NOT NULL DEFAULT 0,
      running     INTEGER NOT NULL DEFAULT 0,
      awaiting_input INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      generation  INTEGER NOT NULL DEFAULT 1,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS summaries (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      generation  INTEGER NOT NULL,
      summary     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    -- Follow-up messages the user typed while a turn was still running, parked
    -- FIFO per task. The runner pops the oldest one as the next turn when the
    -- current turn ends (see lib/runner.ts). Cleared on startup — a turn that
    -- was mid-flight when the process died can't be resumed, so its queue is moot.
    CREATE TABLE IF NOT EXISTS pending_messages (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      generation  INTEGER NOT NULL,
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    -- One row per agent session (one generation of a task). Lets us show every
    -- session that ran under a project. claude_session_id is the agent's own
    -- opaque session/thread id (named for the first driver; a Codex thread id
    -- lands in the same column) — the app only stores and resumes it, never
    -- interprets it.
    CREATE TABLE IF NOT EXISTS sessions (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      generation        INTEGER NOT NULL,
      claude_session_id TEXT,
      started_at        INTEGER NOT NULL,
      ended_at          INTEGER,
      UNIQUE(task_id, generation)
    );

    -- One row per completed Claude turn, carrying the SDK result message's
    -- token usage + dollar cost. Cumulative spend per task/project is SUM(...).
    CREATE TABLE IF NOT EXISTS task_usage (
      id                    TEXT PRIMARY KEY,
      project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id               TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      generation            INTEGER NOT NULL,
      cost_usd              REAL NOT NULL DEFAULT 0,
      input_tokens          INTEGER NOT NULL DEFAULT 0,
      output_tokens         INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      created_at            INTEGER NOT NULL
    );

    -- One row per successful merge that actually landed commits (re-merges of an
    -- already-merged branch don't record). additions/deletions are the line
    -- stats of what that merge introduced on the base branch — captured at merge
    -- time because worktrees (the only other source of diff stats) are deleted
    -- with their task. Feeds the Insights "code merged per day" charts.
    CREATE TABLE IF NOT EXISTS task_merges (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      agent      TEXT NOT NULL DEFAULT 'claude',
      additions  INTEGER NOT NULL DEFAULT 0,
      deletions  INTEGER NOT NULL DEFAULT 0,
      merged_at  INTEGER NOT NULL
    );

    -- Task ordering: a task "depends on" (is blocked by) another. While any
    -- depends_on_id task isn't 'done', the dependent task is shown as blocked and
    -- can't be started. Both sides cascade-delete with their task. CREATE IF NOT
    -- EXISTS means older DBs pick this up automatically — no migrate() entry needed.
    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (task_id, depends_on_id)
    );

    -- App-level key/value preferences that must be readable server-side (e.g. the
    -- default reasoning level + permission mode a task inherits when it hasn't
    -- overridden them). Distinct from the browser-local UI settings in localStorage.
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Persisted service registry (lib/services.ts writes through to this).
    -- Processes never survive a restart; these rows do — so a managed dev server
    -- (desired_state='running') is auto-restarted on boot and its public URL
    -- (slug--<host>) stays stable. slug is the public hostname label, globally
    -- UNIQUE because the hostname carries no project. An expose_service entry
    -- (managed=0 — we don't own the command) persists for URL/visibility
    -- continuity only and is never auto-started.
    CREATE TABLE IF NOT EXISTS services (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      slug          TEXT NOT NULL UNIQUE,
      kind          TEXT NOT NULL,
      command       TEXT NOT NULL DEFAULT '',
      port          INTEGER NOT NULL DEFAULT 0,
      managed       INTEGER NOT NULL DEFAULT 1,
      desired_state TEXT NOT NULL DEFAULT 'stopped',  -- 'running' | 'stopped'
      visibility    TEXT NOT NULL DEFAULT 'private',  -- 'private' | 'shared' | 'public'
      share_token   TEXT NOT NULL DEFAULT '',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      UNIQUE(project_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_services_project ON services(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_deps_dep ON task_dependencies(depends_on_id);
    CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id);
    CREATE INDEX IF NOT EXISTS idx_pending_task ON pending_messages(task_id);
    CREATE INDEX IF NOT EXISTS idx_summaries_task ON summaries(task_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_usage_task ON task_usage(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_usage_project ON task_usage(project_id);
    CREATE INDEX IF NOT EXISTS idx_task_merges_project ON task_merges(project_id);
    CREATE INDEX IF NOT EXISTS idx_task_merges_task ON task_merges(task_id);
  `);

  migrate(db);

  // Reset any stale "running" flags left over from a crash/restart.
  db.prepare("UPDATE tasks SET running = 0 WHERE running = 1").run();
  // Drop any queued follow-ups: the turns they were lined up behind died with
  // the previous process, so there's nothing left to dequeue them.
  db.prepare("DELETE FROM pending_messages").run();

  seedIfEmpty(db);
  ensureOnboardingFlag(db);

  // Re-apply a persisted Anthropic API key (the "I have a key instead" path) to
  // this process's env so the SDK's claude children inherit it after a restart.
  loadPersistedApiKey();
  // Same for a persisted OpenAI API key (the Codex "I have a key instead" path)
  // so the `codex` children pick it up.
  loadPersistedOpenAiKey();
}

// The first-run wizard shows when `onboarding_complete` is unset. A brand-new DB
// leaves it unset (just the single seed project) so the wizard runs; an existing
// in-use instance — one with real history — is marked complete so an upgrade
// never drops a returning user back into onboarding.
function ensureOnboardingFlag(db: Database.Database) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'onboarding_complete'").get();
  if (row) return;
  const n = (q: string) => (db.prepare(q).get() as { n: number }).n;
  // "In use" ignores the built-in Welcome project (seeded = 1): a fresh instance
  // has only that, and must still see the wizard. Any real project, or any run
  // history, means this is an upgrade of a live instance — skip onboarding.
  const inUse =
    n("SELECT COUNT(*) AS n FROM sessions") > 0 ||
    n("SELECT COUNT(*) AS n FROM task_usage") > 0 ||
    n("SELECT COUNT(*) AS n FROM projects WHERE seeded = 0") > 0;
  if (inUse) db.prepare("INSERT INTO settings (key, value) VALUES ('onboarding_complete', '1')").run();
}

// Add columns introduced after a DB was first created (older orchestrator.db files).
export function migrate(db: Database.Database) {
  const cols = (db.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).map((c) => c.name);
  const add = (name: string, def: string) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${def}`);
  };
  add("sub", "TEXT NOT NULL DEFAULT ''");
  add("color", "TEXT NOT NULL DEFAULT '#C2603C'");
  add("context", "TEXT NOT NULL DEFAULT ''");
  add("branch", "TEXT NOT NULL DEFAULT 'main'");
  add("recap", "TEXT NOT NULL DEFAULT ''");
  add("recap_at", "INTEGER NOT NULL DEFAULT 0");
  add("recap_covers_at", "INTEGER NOT NULL DEFAULT 0");
  add("deprecated", "INTEGER NOT NULL DEFAULT 0");
  add("seeded", "INTEGER NOT NULL DEFAULT 0");
  // Per-project managed-services config + the project's deterministic port.
  add("dev_command", "TEXT NOT NULL DEFAULT ''");
  add("setup_command", "TEXT NOT NULL DEFAULT ''");
  add("test_command", "TEXT NOT NULL DEFAULT ''");
  add("port", "INTEGER NOT NULL DEFAULT 0");
  // Backfill a stable port for every project still on 0, in creation order, so an
  // existing instance picks up deterministic ports without a clash. New projects
  // are assigned their port at creation (see store.ts createProject).
  const unported = db.prepare("SELECT id FROM projects WHERE port = 0 ORDER BY created_at ASC, id ASC").all() as { id: string }[];
  if (unported.length) {
    const maxRow = db.prepare("SELECT COALESCE(MAX(port), 0) AS n FROM projects").get() as { n: number };
    let next = Math.max(maxRow.n, SERVICE_PORT_BASE - 1) + 1;
    const setPort = db.prepare("UPDATE projects SET port = ? WHERE id = ?");
    db.transaction(() => { for (const p of unported) setPort.run(next++, p.id); })();
  }
  // Detached "Refresh with AI" job state (drafting now runs in the background,
  // not inside the HTTP request — see lib/contextRefresh.ts).
  add("refresh_status", "TEXT NOT NULL DEFAULT 'idle'");  // idle | running | done | error
  add("refresh_draft", "TEXT NOT NULL DEFAULT ''");       // drafted context awaiting review
  add("refresh_error", "TEXT NOT NULL DEFAULT ''");
  add("refresh_started_at", "INTEGER NOT NULL DEFAULT 0");
  // Agent-driver seam (lib/agents/): which driver new tasks default to. Every
  // pre-seam project ran Claude, so the column default backfills correctly.
  add("default_agent", "TEXT NOT NULL DEFAULT 'claude'");
  // Manual sidebar ordering. Backfill in creation order so existing projects
  // keep the order they had when this column was the implicit sort.
  if (!cols.includes("position")) {
    db.exec("ALTER TABLE projects ADD COLUMN position INTEGER NOT NULL DEFAULT 0");
    db.exec(`
      UPDATE projects SET position = (
        SELECT COUNT(*) FROM projects p2
        WHERE p2.created_at < projects.created_at
           OR (p2.created_at = projects.created_at AND p2.id < projects.id)
      )
    `);
  }
  // Fold legacy building+conventions into the unified context field where empty.
  // One-shot: gated on a persisted settings marker so it runs at most once, ever.
  // Without the guard this re-ran on EVERY boot, and because updateProject never
  // clears building/conventions, a user who intentionally emptied a project's
  // context would silently have it refilled from stale legacy text each restart.
  if (cols.includes("building") && !db.prepare("SELECT 1 FROM settings WHERE key = 'migrated_building_fold'").get()) {
    db.prepare(
      `UPDATE projects SET context = TRIM(building || CASE WHEN conventions != '' THEN char(10) || conventions ELSE '' END)
       WHERE context = '' AND (building != '' OR conventions != '')`
    ).run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('migrated_building_fold', '1')").run();
  }

  // Per-task git worktree isolation columns (added after first release).
  const taskCols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
  if (!taskCols.includes("worktree_path")) db.exec("ALTER TABLE tasks ADD COLUMN worktree_path TEXT NOT NULL DEFAULT ''");
  if (!taskCols.includes("work_branch")) db.exec("ALTER TABLE tasks ADD COLUMN work_branch TEXT NOT NULL DEFAULT ''");
  if (!taskCols.includes("base_sha")) db.exec("ALTER TABLE tasks ADD COLUMN base_sha TEXT NOT NULL DEFAULT ''");
  if (!taskCols.includes("merged_at")) db.exec("ALTER TABLE tasks ADD COLUMN merged_at INTEGER NOT NULL DEFAULT 0");
  if (!taskCols.includes("awaiting_input")) db.exec("ALTER TABLE tasks ADD COLUMN awaiting_input INTEGER NOT NULL DEFAULT 0");
  // Per-task model selection (NULL = inherit Claude's default) and the model the
  // SDK actually resolved for the last turn (shown as a badge in the chat).
  if (!taskCols.includes("model")) db.exec("ALTER TABLE tasks ADD COLUMN model TEXT");
  if (!taskCols.includes("resolved_model")) db.exec("ALTER TABLE tasks ADD COLUMN resolved_model TEXT");
  // Per-task run controls (added after model selection): thinking preset + permission mode.
  if (!taskCols.includes("reasoning")) db.exec("ALTER TABLE tasks ADD COLUMN reasoning TEXT");
  if (!taskCols.includes("permission_mode")) db.exec("ALTER TABLE tasks ADD COLUMN permission_mode TEXT");
  // Agent-driver seam: which driver runs this task's sessions. Every pre-seam
  // task ran Claude, so the column default backfills existing rows correctly.
  if (!taskCols.includes("agent")) db.exec("ALTER TABLE tasks ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude'");

  // Which driver produced each usage row, stamped at write time (Insights breaks
  // spend down by provider). Backfilled from the task's current agent — exact
  // for every pre-existing row since tasks couldn't switch agents until now.
  const usageCols = (db.prepare("PRAGMA table_info(task_usage)").all() as { name: string }[]).map((c) => c.name);
  if (!usageCols.includes("agent")) {
    db.exec("ALTER TABLE task_usage ADD COLUMN agent TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE task_usage SET agent = COALESCE((SELECT t.agent FROM tasks t WHERE t.id = task_usage.task_id), 'claude') WHERE agent = ''");
  }

  // Backfill the sessions table from existing message history (one row per
  // task generation). Idempotent via UNIQUE(task_id, generation) + OR IGNORE,
  // so it only ever fills gaps for sessions that predate the sessions table.
  db.exec(`
    INSERT OR IGNORE INTO sessions (id, project_id, task_id, generation, claude_session_id, started_at, ended_at)
    SELECT lower(hex(randomblob(10))), t.project_id, m.task_id, m.generation,
           CASE WHEN m.generation = t.generation THEN t.session_id ELSE NULL END,
           MIN(m.created_at), MAX(m.created_at)
    FROM messages m JOIN tasks t ON t.id = m.task_id
    WHERE m.role IN ('user', 'assistant', 'tool')
    GROUP BY m.task_id, m.generation;
  `);
}

// The built-in tutorial. A brand-new instance gets a "Welcome" project backed by
// a real (tiny) repo plus two tasks that teach the whole loop — start a session,
// answer a question, review a diff, merge — before the user touches their own
// code. It's an ordinary project: deletable, and it never comes back (the
// persistent `seed_done` flag guards against a re-seed after it's removed, even
// if the projects table is momentarily empty again).
function seedIfEmpty(db: Database.Database) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number };
  if (count.n > 0) return;
  const done = db.prepare("SELECT value FROM settings WHERE key = 'seed_done'").get();
  if (done) return;

  const now = Date.now();
  const pid = nanoid();

  // Scaffold the tiny site into PROJECTS_DIR so diffs/merges are real. If it
  // fails (permissions, read-only home), the project is still created but with a
  // blank repo_path, so the app never crashes on first boot — the user just sets
  // a working directory themselves.
  const repoPath = scaffoldWelcomeRepo();

  db.prepare(
    `INSERT INTO projects (id, name, icon, sub, color, context, repo_path, branch, port, seeded, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(
    pid,
    "Welcome",
    "W",
    "start here",
    "#C2603C",
    WELCOME_CONTEXT,
    repoPath,
    "main",
    SERVICE_PORT_BASE,
    now
  );

  const seedTask = (title: string, description: string, priority: string, suggested: number) =>
    db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, description, priority, status, suggested, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'not_started', ?, ?, ?)`
      )
      .run(nanoid(), pid, title, description, priority, suggested, now, now);

  // The hands-on task: it drives the full loop in one turn — a question, a
  // one-file edit, a diff to review, a one-click merge. Its title + description
  // become the first prompt (see app/api/tasks/[id]/messages), so the steps are
  // written as instructions to Claude.
  seedTask("Try me: add a tagline", TUTORIAL_TASK_DESC, "hi", 0);
  // A pre-loaded "suggested" task so the tray isn't empty — this is exactly what
  // a Claude session drops there when it proposes follow-up work.
  seedTask(
    "Add a dark-mode toggle",
    "Give Aurora a light/dark theme toggle: a small button that flips the page between a light and a dark palette and remembers the choice. Touch index.html and styles.css (and a little JS if you need it).",
    "med",
    1
  );

  db.prepare("INSERT INTO settings (key, value) VALUES ('seed_done', '1')").run();
  // Remember which project is the tutorial so the client can surface coach marks
  // and the post-merge nudge for it (also derivable from projects.seeded = 1).
  db.prepare("INSERT INTO settings (key, value) VALUES ('seed_project_id', ?)").run(pid);
}

// Claude-facing project context for the Welcome tutorial. Describes the actual
// scaffolded repo (so the session behaves), with one line of framing. The
// heavier "how Operator works" teaching lives in the UI coach marks, not here.
const WELCOME_CONTEXT =
  "Aurora is a tiny one-page website — a placeholder landing page. The repo has just three files: " +
  "index.html (the page), styles.css (its styling), and README.md. It's intentionally minimal so " +
  "every change is small and easy to review.\n\n" +
  "This \"Welcome\" project is a guided tour of Operator. Starting the task on the right runs a real " +
  "Claude session end to end — it streams its tool calls, asks you a question, makes a small change, " +
  "and hands you a diff to review and merge, all in your own workspace. When you're comfortable, " +
  "delete this project and add one for your real codebase.";

const TUTORIAL_TASK_DESC =
  "This is a 2-minute hands-on tour of Operator — it walks the whole loop in one session.\n\n" +
  "Please do exactly this:\n" +
  "1. First, ask me which tagline style I'd like using a question with a few options — for example " +
  "Playful, Professional, and Minimal. Wait for my answer before editing.\n" +
  "2. Read index.html, then add a single short tagline line directly under the <h1> headline, in the " +
  "style I chose. Keep the change to that one file so the diff is tiny.\n" +
  "3. Tell me in one sentence what you changed, and that it's ready to review in the Changes tab and merge.\n\n" +
  "Keep it small — one line of copy is perfect.";

// Write the Aurora demo site into PROJECTS_DIR/welcome. Returns the path, or ""
// if anything goes wrong (best-effort; must never throw — runs during DB init).
function scaffoldWelcomeRepo(): string {
  try {
    const dir = path.join(PROJECTS_DIR, "welcome");
    // Don't clobber an existing folder — a prior boot may have created it, and it
    // could already be a git repo with the user's tutorial edits.
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, body] of Object.entries(WELCOME_FILES)) {
        fs.writeFileSync(path.join(dir, name), body);
      }
    }
    return dir;
  } catch {
    return "";
  }
}

// The scaffolded site. Deliberately plain HTML/CSS (no build step) so a task's
// edit produces a clean, readable one-file diff. index.html has no tagline yet —
// that's what "Try me: add a tagline" fills in, right under the <h1>.
const WELCOME_FILES: Record<string, string> = {
  "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Aurora</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main class="hero">
      <h1>Aurora</h1>
      <!-- A tagline goes here -->
      <a class="cta" href="#">Get started</a>
    </main>
  </body>
</html>
`,
  "styles.css": `:root {
  --bg: #faf7f2;
  --ink: #2a2622;
  --muted: #6b645c;
  --accent: #c2603c;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  background: var(--bg);
  color: var(--ink);
}

.hero {
  text-align: center;
  padding: 48px;
}

.hero h1 {
  margin: 0;
  font-size: 56px;
  letter-spacing: -0.02em;
}

.tagline {
  margin: 12px 0 0;
  font-size: 18px;
  color: var(--muted);
}

.cta {
  display: inline-block;
  margin-top: 28px;
  padding: 12px 22px;
  border-radius: 10px;
  background: var(--accent);
  color: #fff;
  text-decoration: none;
  font-weight: 600;
}
`,
  "README.md": `# Aurora

A tiny one-page site used for the Operator welcome tour. Three files, no build step:

- \`index.html\` — the page
- \`styles.css\` — the styling
- \`README.md\` — this file

Small on purpose, so every change is easy to read and merge.
`,
};

export function getDb(): Database.Database {
  if (!global.__orchDb) {
    // Create the app-data home on first run (idempotent).
    fs.mkdirSync(DB_DIR, { recursive: true });
    const db = new Database(DB_PATH);
    init(db);
    global.__orchDb = db;
  }
  return global.__orchDb;
}
