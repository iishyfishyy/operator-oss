import type { TaskRow } from "./types";

// Grouping for the "Suggested by agents" tray. Every suggestion carries the task
// (and that task's /clear generation) whose session proposed it — see
// createSuggestedTask in lib/agentTools.ts — so a tray filled by several sessions
// planning at once can be read one proposer at a time instead of as one flat pile.
//
// Both tray surfaces (the list column and the board's Suggested column) render
// the same groups from this one helper, through the same SuggestionGroup
// component, so they can't drift.
//
// Groups also carry FRESHNESS: a tray is a pile that only ever grows, so the
// question "which of these arrived just now, and which are leftovers from a
// session that has since finished?" is the one it has to answer at a glance.
// That's `newestAt` (age chip + newest-first order) and `stale`.

/** A group nobody has touched in this long reads as stale (see `stale`). */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Why a group has no proposer to name:
 * - `parent` — resolved: we know the task and session that proposed it.
 * - `gone`   — it recorded a proposer, but that task no longer exists (hard
 *              delete). `tasks.suggested_by_task_id` is a FOREIGN KEY with
 *              ON DELETE SET NULL, so deleting the proposer erases the id — but
 *              NOT `suggested_by_generation`, which has no FK. A row with a
 *              generation and no id is therefore durable positive evidence that
 *              the proposer was deleted, which makes the group stale.
 * - `other`  — no proposer was ever recorded (pre-provenance rows): both
 *              columns null, which says nothing either way about staleness.
 */
export type SuggestionGroupKind = "parent" | "gone" | "other";

export interface SuggestionGroup {
  key: string; // stable React key
  kind: SuggestionGroupKind;
  parent: TaskRow | null; // the proposing task, when we still have it
  generation: number | null; // the proposer's session number when it suggested
  tasks: TaskRow[];
  newestAt: number; // created_at of the most recent member — the group's age + sort key
  oldestAt: number; // created_at of the earliest member
  stale: boolean; // old, or proposed by a task that's finished/gone (see staleReason)
  staleReason: string; // one clause explaining `stale`; "" when fresh
}

/** Header text for a group — "From: <title> · session N", or the fallback bucket's name. */
export function suggestionGroupLabel(g: SuggestionGroup): string {
  if (g.kind === "gone") return "From a deleted task";
  if (!g.parent) return "Other";
  return g.generation && g.generation > 0 ? `From: ${g.parent.title} · session ${g.generation}` : `From: ${g.parent.title}`;
}

// A suggestion whose proposer reached a terminal state is a leftover: the work
// that motivated it is over (merging a task marks it done), so nobody is going
// to come back and explain it. Same for a proposer that was deleted outright.
function staleReasonFor(g: Omit<SuggestionGroup, "stale" | "staleReason">, now: number): string {
  if (g.kind === "gone") return "the task that proposed these was deleted";
  if (g.parent?.status === "done") return `“${g.parent.title}” is done`;
  if (g.parent?.status === "cancelled") return `“${g.parent.title}” was cancelled`;
  if (now - g.newestAt > STALE_AFTER_MS) return "suggested over a week ago";
  return "";
}

/**
 * Bucket `suggested` by proposing (task, generation), then order the buckets
 * newest-first so whatever just landed reads first. Members keep their input
 * order — the tray is fed in position order and a suggest_task batch is created
 * in one sequence, so a single planning call stays intact and in the order it
 * was proposed.
 *
 * `all` is the project's full task list (real + suggested), used to resolve a
 * parent id to its row. An id that resolves to nothing means the proposer was
 * deleted (`gone`); no id at all is a pre-provenance row (`other`). Both are
 * fallbacks rather than headlines, so they trail the named groups.
 *
 * `now` is injectable so staleness is testable without faking the clock.
 */
export function groupSuggestions(suggested: TaskRow[], all: TaskRow[], now: number = Date.now()): SuggestionGroup[] {
  const byId = new Map(all.map((t) => [t.id, t]));
  type Draft = Omit<SuggestionGroup, "stale" | "staleReason">;
  const drafts: Draft[] = [];
  const index = new Map<string, Draft>();

  const bucket = (key: string, kind: SuggestionGroupKind, parent: TaskRow | null, generation: number | null) => {
    let g = index.get(key);
    if (!g) {
      g = { key, kind, parent, generation, tasks: [], newestAt: 0, oldestAt: Number.POSITIVE_INFINITY };
      index.set(key, g);
      drafts.push(g);
    }
    return g;
  };

  for (const t of suggested) {
    const parent = t.suggested_by_task_id ? byId.get(t.suggested_by_task_id) : undefined;
    // Any surviving provenance trace with no resolvable proposer means the
    // proposer is gone: either the FK nulled the id (durable) or this client's
    // list is a beat behind a delete that just happened (transient).
    const orphaned = t.suggested_by_task_id !== null || t.suggested_by_generation !== null;
    const g = parent
      ? bucket(`${parent.id}:${t.suggested_by_generation ?? 0}`, "parent", parent, t.suggested_by_generation)
      : orphaned
        ? bucket("gone", "gone", null, null)
        : bucket("other", "other", null, null);
    g.tasks.push(t);
    const at = t.created_at ?? 0;
    if (at > g.newestAt) g.newestAt = at;
    if (at < g.oldestAt) g.oldestAt = at;
  }

  // Newest-first, with the two unattributed buckets trailing every named group
  // (a bucket we can't label is never the headline, however recent it is).
  const rank = (g: Draft) => (g.kind === "parent" ? 0 : g.kind === "gone" ? 1 : 2);
  drafts.sort((a, b) => rank(a) - rank(b) || b.newestAt - a.newestAt);

  return drafts.map((g) => {
    const reason = staleReasonFor(g, now);
    return { ...g, oldestAt: Number.isFinite(g.oldestAt) ? g.oldestAt : g.newestAt, stale: !!reason, staleReason: reason };
  });
}

/** Was this suggestion created since the user last looked at the tray? */
export const isNewSuggestion = (t: TaskRow, since: number) => (t.created_at ?? 0) > since;

/** How many of these suggestions are new — the "N new" count on the tray header. */
export const countNewSuggestions = (suggested: TaskRow[], since: number) =>
  suggested.reduce((n, t) => n + (isNewSuggestion(t, since) ? 1 : 0), 0);
