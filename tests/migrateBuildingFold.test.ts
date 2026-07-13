import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { init, migrate } from "../lib/db";

// Build a legacy-shaped orchestrator.db. The schema still carries the legacy
// building/conventions columns, so init() alone gives us the shape we need to
// exercise the one-shot fold that folds them into the unified `context` field.
// init() runs migrate once, but with no legacy data present it neither folds nor
// sets the marker, so each test starts from a genuinely un-migrated state.
function legacyDb() {
  const db = new Database(":memory:");
  init(db);
  db.prepare("DELETE FROM settings WHERE key = 'migrated_building_fold'").run();
  return db;
}

function insertProject(db: Database.Database, id: string, fields: { context?: string; building?: string; conventions?: string }) {
  db.prepare(
    `INSERT INTO projects (id, name, icon, sub, color, context, repo_path, branch, port, position, created_at, building, conventions)
     VALUES (?, ?, '?', '', '#C2603C', ?, '', 'main', 0, 0, ?, ?, ?)`
  ).run(id, "P", fields.context ?? "", Date.now(), fields.building ?? "", fields.conventions ?? "");
}

const ctx = (db: Database.Database, id: string) =>
  (db.prepare("SELECT context FROM projects WHERE id = ?").get(id) as { context: string }).context;

const marked = (db: Database.Database) =>
  !!db.prepare("SELECT 1 FROM settings WHERE key = 'migrated_building_fold'").get();

let open: Database.Database | undefined;
afterEach(() => open?.close());

describe("legacy building/conventions → context fold", () => {
  it("folds an un-migrated legacy DB exactly once and records the marker", () => {
    const db = (open = legacyDb());
    insertProject(db, "p1", { building: "Ships a widget", conventions: "Use tabs" });
    expect(marked(db)).toBe(false);

    migrate(db);
    expect(ctx(db, "p1")).toBe("Ships a widget\nUse tabs");
    expect(marked(db)).toBe(true);
  });

  it("does NOT resurrect context the user deliberately cleared after the fold ran", () => {
    const db = (open = legacyDb());
    insertProject(db, "p1", { building: "Ships a widget", conventions: "Use tabs" });

    migrate(db); // first boot: folds
    expect(ctx(db, "p1")).toBe("Ships a widget\nUse tabs");

    // User clears the project's context via the UI (updateProject writes context
    // only; building/conventions stay frozen — the exact resurrection setup).
    db.prepare("UPDATE projects SET context = '' WHERE id = ?").run("p1");

    migrate(db); // restart: must be a no-op, not a re-fold
    expect(ctx(db, "p1")).toBe("");
  });
});
