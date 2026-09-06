import type { TaskRow } from "./types";

// Grouping for the "Suggested by agents" tray. Every suggestion carries the task
// (and that task's /clear generation) whose session proposed it — see
// createSuggestedTask in lib/agentTools.ts — so a tray filled by several sessions
// planning at once can be read one proposer at a time instead of as one flat pile.
//
// Both tray surfaces (the list column and the board's Suggested column) render
// the same groups from this one helper so they can't drift.

export interface SuggestionGroup {
  key: string; // stable React key; "other" for the ungrouped bucket
  parent: TaskRow | null; // null = unknown proposer (pre-migration row, or it was deleted)
  generation: number | null; // the proposer's session number when it suggested
  tasks: TaskRow[];
}

/** Header text for a group — "From: <title> · session N", or "Other". */
export function suggestionGroupLabel(g: SuggestionGroup): string {
  if (!g.parent) return "Other";
  return g.generation && g.generation > 0 ? `From: ${g.parent.title} · session ${g.generation}` : `From: ${g.parent.title}`;
}

/**
 * Bucket `suggested` by proposing (task, generation). Groups appear in the order
 * their first member appears in the input, and members keep their input order —
 * the tray is fed in position order, and a suggest_task batch is created in one
 * sequence, so a single planning call stays intact and in the order it was
 * proposed. Suggestions whose proposer is unknown collect in a trailing "Other".
 *
 * `all` is the project's full task list (real + suggested), used to resolve a
 * parent id to its row; an id that resolves to nothing falls into "Other".
 */
export function groupSuggestions(suggested: TaskRow[], all: TaskRow[]): SuggestionGroup[] {
  const byId = new Map(all.map((t) => [t.id, t]));
  const groups: SuggestionGroup[] = [];
  const index = new Map<string, SuggestionGroup>();
  let other: SuggestionGroup | null = null;

  for (const t of suggested) {
    const parent = t.suggested_by_task_id ? byId.get(t.suggested_by_task_id) : undefined;
    if (!parent) {
      if (!other) other = { key: "other", parent: null, generation: null, tasks: [] };
      other.tasks.push(t);
      continue;
    }
    const key = `${parent.id}:${t.suggested_by_generation ?? 0}`;
    let g = index.get(key);
    if (!g) {
      g = { key, parent, generation: t.suggested_by_generation, tasks: [] };
      index.set(key, g);
      groups.push(g);
    }
    g.tasks.push(t);
  }
  // "Other" is a fallback, never the headline — it always sorts last.
  if (other) groups.push(other);
  return groups;
}

/**
 * Whether to draw the per-group headers at all. A tray where nothing has a known
 * proposer (every pre-migration instance, right after upgrading) would otherwise
 * grow a single meaningless "Other" heading over the same flat list it had before.
 */
export function showsGroupHeaders(groups: SuggestionGroup[]): boolean {
  return groups.some((g) => g.parent);
}
