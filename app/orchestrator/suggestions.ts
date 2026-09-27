import type { Msg, TaskRow } from "./types";
import type { Priority, ToolData, ToolSuggestion } from "@/lib/types";

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

  for (const t of all.filter((t) => t.suggested)) {
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

  // Dependency links connect provenance buckets in either direction. Merge to
  // a fixed point so a bridge also pulls in all of its provenance siblings.
  for (let i = 0; i < drafts.length; i++) {
    for (let j = i + 1; j < drafts.length; j++) {
      const a = drafts[i], b = drafts[j];
      const aIds = new Set(a.tasks.map((t) => t.id));
      const bIds = new Set(b.tasks.map((t) => t.id));
      if (!a.tasks.some((t) => t.depends_on?.some((id) => bIds.has(id))) &&
          !b.tasks.some((t) => t.depends_on?.some((id) => aIds.has(id)))) continue;
      a.tasks.push(...b.tasks);
      a.newestAt = Math.max(a.newestAt, b.newestAt);
      a.oldestAt = Math.min(a.oldestAt, b.oldestAt);
      drafts.splice(j, 1);
      i = -1;
      break;
    }
  }
  const visible = new Set(suggested.map((t) => t.id));
  // Searching selects whole groups, never a silently partial chain.
  for (let i = drafts.length - 1; i >= 0; i--) {
    if (!drafts[i].tasks.some((t) => visible.has(t.id))) drafts.splice(i, 1);
    else drafts[i].tasks = orderSuggestionChain(drafts[i].tasks);
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

// ---------- suggestions as seen from the proposer's transcript ----------
//
// A suggest_task call is persisted as a "tool" message whose ToolData carries a
// `suggestion` (the proposed title + the created task's id, see lib/types.ts).
// The transcript renders those as live chips keyed by the id against the
// project's task list — so a rename made anywhere shows everywhere, and a
// deleted suggestion reads as dismissed. These helpers are the pure half.

/** One suggest_task card in a transcript: the message it lives on + its payload. */
export interface SuggestionCard {
  msgId: string;
  suggestion: ToolSuggestion;
  /** When the card landed (the row's created_at), for the chip's "just filed" grace. */
  ts?: number;
}

/** The suggestion payload of a tool message, or null for any other message. */
export function parseSuggestionCard(m: Msg): ToolSuggestion | null {
  // Cheap pre-check: JSON.parse over every tool row on every render would be
  // wasteful in a long transcript, and only suggest_task rows carry the key.
  if (m.role !== "tool" || !m.content.includes('"suggestion"')) return null;
  try {
    const data = JSON.parse(m.content) as ToolData;
    return data.suggestion && typeof data.suggestion.title === "string" ? data.suggestion : null;
  } catch {
    return null;
  }
}

/**
 * Batches for the "Suggested this session" summary: a turn (the run of messages
 * from one user message to the next) that filed TWO OR MORE suggestions gets one
 * block after its last message, listing every chip together — so a planning
 * turn's five tasks read as one compact unit at the end instead of five cards
 * scattered among the tool calls that produced them. Keyed by the id of the
 * turn's last message, which is where the block renders. A single suggestion
 * needs no summary; its inline chip already is the summary.
 */
export function suggestionBatches(messages: Msg[]): Map<string, SuggestionCard[]> {
  const out = new Map<string, SuggestionCard[]>();
  let cards: SuggestionCard[] = [];
  let lastId: string | null = null;
  const flush = () => {
    if (lastId && cards.length >= 2) out.set(lastId, cards);
    cards = [];
    lastId = null;
  };
  for (const m of messages) {
    if (m.role === "user" || m.role === "session_break" || m.role === "queued") {
      flush();
      if (m.role !== "user") continue;
    }
    lastId = m.id;
    const suggestion = parseSuggestionCard(m);
    if (suggestion) cards.push({ msgId: m.id, suggestion, ts: m.ts });
  }
  flush();
  return out;
}

/** Stable topological order, ignoring blockers outside this suggested group. */
export function orderSuggestionChain(tasks: TaskRow[]): TaskRow[] {
  const remaining = new Map(tasks.map((t) => [t.id, t]));
  const ordered: TaskRow[] = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter((t) => !t.depends_on?.some((id) => remaining.has(id)));
    if (!ready.length) { ordered.push(...remaining.values()); break; }
    for (const t of ready) { ordered.push(t); remaining.delete(t.id); }
  }
  return ordered;
}

// ---------- tray row presentation ----------

const PRIORITY_TAGS: Record<string, Priority> = {
  hi: "hi", high: "hi", urgent: "hi", p0: "hi", p1: "hi",
  med: "med", medium: "med", mid: "med", p2: "med",
  lo: "lo", low: "lo", p3: "lo",
};

/**
 * Split an agent's bracket-prefixed title ("[AO][Med] Fix the thing") into its
 * tag chips, a priority, and the plain-English title. Only LEADING brackets are
 * parsed — a bracket mid-title is part of the title. A priority token becomes
 * the pill rather than a tag; with none, the caller falls back to the row's own
 * priority column.
 */
export function parseSuggestionTitle(title: string): { text: string; tags: string[]; priority: Priority | null } {
  const tags: string[] = [];
  let priority: Priority | null = null;
  let rest = title.trimStart();
  for (let m = /^\[([^\]\n]{1,24})\]\s*/.exec(rest); m; m = /^\[([^\]\n]{1,24})\]\s*/.exec(rest)) {
    const tok = m[1].trim();
    const p = PRIORITY_TAGS[tok.toLowerCase()];
    if (p) priority ??= p;
    else if (tok) tags.push(tok);
    rest = rest.slice(m[0].length);
  }
  // A title that was ALL brackets keeps its raw text rather than going blank.
  return rest.trim() ? { text: rest.trim(), tags, priority } : { text: title, tags: [], priority: null };
}

/** The tag every member of a group shares — shown once on the group header instead of per row. */
export function commonSuggestionTag(tasks: TaskRow[]): string | null {
  const [first, ...rest] = tasks.map((t) => parseSuggestionTitle(t.title).tags);
  if (!first) return null;
  return first.find((tag) => rest.every((tags) => tags.includes(tag))) ?? null;
}

/** Do this group's members depend on each other? Then order means something and the rows read as a chain. */
export function isOrderedGroup(tasks: TaskRow[]): boolean {
  const ids = new Set(tasks.map((t) => t.id));
  return tasks.some((t) => t.depends_on?.some((id) => ids.has(id)));
}

/**
 * When a composed chain's next task starts:
 * - `done` — after the previous one is marked done (merging marks it done);
 * - `now`  — all at once, in parallel;
 * - `auto` — "Auto-advance, review at end": as soon as the previous step calls
 *   complete_step and its turn ends cleanly, stacked on the previous step's
 *   branch; nothing merges until the user reviews the chain (lib/chains.ts).
 */
export type ChainAdvance = "done" | "now" | "auto";

/** Is this a sequential advance mode (each task linked to the one before it)? */
export const isSequentialAdvance = (advance: ChainAdvance) => advance !== "now";

/**
 * The dependency edits that turn a reviewed group into the chain the user
 * composed. `groupIds` is the whole group; `ordered` the selected members in
 * launch order. Every in-group edge on a selected task is replaced — the
 * user's order is now the authority, and an edge onto an EXCLUDED member would
 * block it behind a suggestion that may never be accepted — while edges onto
 * tasks outside the group are kept. `advance: "done"` links each task to the
 * one before it (so does `"auto"` — the chain row, created on accept, is what
 * makes it advance on complete_step); `"now"` leaves them unlinked so they all
 * start together.
 *
 * Two passes, because setTaskDeps has a cycle guard: re-linking B → A while A
 * still carries its old A → B edge would be rejected. `clear` strips the
 * in-group edges from every selected task first; `link` then adds the chain.
 * Only tasks whose deps actually change appear in either pass.
 */
export function planChainDeps(tasks: TaskRow[], groupIds: string[], ordered: string[], advance: ChainAdvance) {
  const inGroup = new Set(groupIds);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const clear: { id: string; depends_on: string[] }[] = [];
  const link: { id: string; depends_on: string[] }[] = [];
  ordered.forEach((id, i) => {
    const current = byId.get(id)?.depends_on ?? [];
    const outside = current.filter((d) => !inGroup.has(d));
    const final = isSequentialAdvance(advance) && i > 0 ? [...outside, ordered[i - 1]] : outside;
    if (same(current, final)) return;
    if (!same(current, outside)) clear.push({ id, depends_on: outside });
    if (!same(outside, final)) link.push({ id, depends_on: final });
  });
  return { clear, link };
}
