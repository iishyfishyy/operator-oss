"use client";

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Priority } from "@/lib/types";
import { Icon } from "../icons";
import { clockTime, isAwaiting, relTime, shortAge } from "./format";
import { StatusDot } from "./shared";
import type { AgentsBundle, TaskRow } from "./types";
import type { PendingDismiss } from "./useOrchestrator";
import {
  commonSuggestionTag, countNewSuggestions, isOrderedGroup, parseSuggestionTitle, suggestionGroupLabel,
  type ChainAdvance, type SuggestionGroup as Group,
} from "./suggestions";

// The "Suggested by agents" tray, shared by both surfaces (the list column's
// tray and the board's Suggested column). Everything that answers "should I
// care about this pile?" lives here — who proposed it, how old it is, how much
// of it is new since you last looked, and whether it's a leftover from a
// session that has since finished — so the two surfaces can't disagree.
//
// One header per group: the source line (a live link to the proposing task,
// with its status dot) over one summary bar whose actions are ranked by intent
// — Start chain (primary) · Accept all · Dismiss all (quiet). Per-row actions
// only appear on hover. "Start chain" never fires blind: it opens the inline
// ChainComposer to pick, order, and route the batch first.

/**
 * The per-project "new since" mark, plus a ref to hang on the tray container.
 *
 * The mark is FROZEN for as long as the tray stays mounted on one project:
 * seeing the tray advances the stored mark (that's the point — next visit those
 * suggestions aren't new any more), but if the rendered comparison moved with
 * it, every "new" pill would vanish the instant you laid eyes on it. So the
 * pills you're looking at stay put until you leave and come back.
 *
 * `ready` gates on the prefs having hydrated from localStorage. Before that the
 * mark is unknown, and guessing 0 would flash "new" on the whole tray on every
 * page load; an infinite mark means nothing is new yet, and nothing is recorded.
 */
export function useTrayView({ projectId, seenAt, ready, onViewed }: {
  projectId: string;
  seenAt: number | undefined; // undefined = this project's tray has never been seen
  ready: boolean;
  onViewed: (projectId: string) => void;
}) {
  const frozen = useRef<{ proj: string; since: number } | null>(null);
  if (ready && (!frozen.current || frozen.current.proj !== projectId)) {
    frozen.current = { proj: projectId, since: seenAt ?? 0 };
  }
  const newSince = ready && frozen.current ? frozen.current.since : Number.POSITIVE_INFINITY;

  // A state-backed callback ref, not a plain one: the tray mounts LATER than
  // this hook's owner whenever the first suggestion of a project arrives mid-
  // session, and a plain ref wouldn't re-run the observer effect when it does.
  const [node, setNode] = useState<HTMLElement | null>(null);
  const trayRef = useCallback((el: HTMLElement | null) => setNode(el), []);
  const marked = useRef<string | null>(null);

  useEffect(() => {
    if (!ready || !node || marked.current === projectId) return;
    const mark = () => {
      if (marked.current === projectId) return;
      marked.current = projectId;
      onViewed(projectId);
    };
    // Scrolled into view counts as seen. Without the observer (jsdom, older
    // engines) fall back to "rendered counts as seen" rather than never marking.
    if (typeof IntersectionObserver === "undefined") { mark(); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { mark(); io.disconnect(); }
    });
    io.observe(node);
    return () => io.disconnect();
  }, [ready, node, projectId, onViewed]);

  return { newSince, trayRef };
}

/** The per-suggestion "new" marker — one pill, both surfaces. */
export function NewPill({ title }: { title?: string }) {
  return <span className="sug-new" title={title ?? "Suggested since you last looked at this tray"}>new</span>;
}

/** Launch payload from the chain composer — see launchChain in useOrchestrator. */
export interface ChainLaunch { groupIds: string[]; ordered: string[]; agent: string | null; advance: ChainAdvance; start: boolean }

/** Groups longer than this fold to their first ROWS_FOLDED rows behind "+ N more". */
const ROWS_MAX = 6;
const ROWS_FOLDED = 5;

const PRI_LABEL: Record<Priority, string> = { hi: "HIGH", med: "MED", lo: "LOW" };
function SxPill({ p }: { p: Priority }) {
  return <span className={`sx-pill ${p}`}>{PRI_LABEL[p]}</span>;
}

/** `code` spans in an agent's one-line rationale, rendered as code. */
function inlineCode(text: string): ReactNode {
  const parts = text.split(/`([^`\n]+)`/);
  return parts.length === 1 ? text : parts.map((part, i) => (i % 2 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>));
}

const PlayGlyph = () => <svg viewBox="0 0 10 10" fill="currentColor" aria-hidden><path d="M2.5 1.5v7l6-3.5z" /></svg>;
const ChainGlyph = () => (
  <svg viewBox="0 0 12 10" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden>
    <circle cx="2" cy="5" r="1.4" /><circle cx="10" cy="5" r="1.4" /><path d="M3.4 5h5.2" />
  </svg>
);
const GripGlyph = () => (
  <svg viewBox="0 0 8 12" fill="currentColor" aria-hidden>
    {[2, 6, 10].map((y) => <Fragment key={y}><circle cx="2" cy={y} r="1" /><circle cx="6" cy={y} r="1" /></Fragment>)}
  </svg>
);
const CheckGlyph = () => <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden><path d="M2 5.2l2 2 4-4.4" /></svg>;

/** The tray's section header: title, count, and — when folded — a one-line digest. */
export function TrayHeader({ count, newCount, groups, collapsed, onToggle, onDismissStale }: {
  count: number; newCount: number; groups: Group[];
  collapsed?: boolean; onToggle?: () => void;
  onDismissStale?: (ids: string[]) => void;
}) {
  const staleIds = groups.filter((g) => g.stale).flatMap((g) => g.tasks.map((t) => t.id));
  return (
    <div className="sx-h">
      <span className="sx-spark">{Icon.spark()}</span>
      <span className="sx-ttl">Suggested<span className="sx-ttl-x"> by agents</span></span>
      <span className="sx-ct">{count}</span>
      {newCount > 0 && <span className="sh-new sx-h-new">{newCount} new</span>}
      {collapsed && (
        <span className="sx-digest">
          {groups.length} source{groups.length === 1 ? "" : "s"}{staleIds.length > 0 && ` · ${staleIds.length} stale`}
        </span>
      )}
      <span className="sx-sp" />
      {!collapsed && onDismissStale && staleIds.length > 0 && (
        <button className="sx-ghost" onClick={() => onDismissStale(staleIds)} title={`Dismiss the ${staleIds.length} suggestions in stale groups`}>
          Dismiss stale
        </button>
      )}
      {onToggle && (
        <button className="sx-icon" aria-expanded={!collapsed} onClick={onToggle} title={collapsed ? "Show suggestions" : "Collapse suggestions"}>
          {Icon.chevDown({ style: { transform: collapsed ? undefined : "rotate(180deg)" } })}
        </button>
      )}
    </div>
  );
}

/** "Dismissed N suggestions … Undo" — the only confirmation a dismissal gets. */
export function UndoToast({ pending, onUndo }: { pending: PendingDismiss; onUndo: () => void }) {
  const n = pending.ids.length;
  return (
    <div className="sx-toast" role="status">
      <span className="t"><b>Dismissed {n === 1 ? "1 suggestion" : `${n} suggestions`}</b>{pending.label && ` ${pending.label}`}</span>
      <button className="sx-b" onClick={onUndo}>Undo</button>
    </div>
  );
}

/**
 * One suggestion in the list tray: numbered node on the chain rail, the parsed
 * title (bracket prefixes become a tag + priority pill), the agent's one-line
 * rationale, and hover-only actions.
 */
export function SuggestionRow({ task, position, groupTag, isNew, outsideBlockers, onEdit, onDismiss, onAccept, onStart }: {
  task: TaskRow; position: number | null; groupTag: string | null; isNew: boolean; outsideBlockers: string[];
  onEdit: () => void; onDismiss: () => void; onAccept: () => void; onStart: () => void;
}) {
  const { text, tags, priority } = parseSuggestionTitle(task.title);
  return (
    <div className={`sx-row ${isNew ? "is-new" : ""}`}>
      <div className="sx-node"><i>{position ?? ""}</i></div>
      <div className="sx-main">
        <div className="sx-rt">
          {isNew && <NewPill />}
          <span className="sg-name" title={task.title}>{text}</span>
          {tags.filter((t) => t !== groupTag).map((t) => <span key={t} className="sx-tag">{t}</span>)}
          <SxPill p={priority ?? task.priority} />
        </div>
        {task.description && <div className="sx-rd" title={task.description}>{inlineCode(task.description)}</div>}
        {outsideBlockers.length > 0 && <div className="sx-rb">← Blocked by {outsideBlockers.join(", ")}</div>}
      </div>
      <div className="sx-acts">
        <button className="sx-icon" title="Edit title & description" aria-label="Edit suggestion" onClick={onEdit}>{Icon.edit()}</button>
        <button className="sx-icon" title="Dismiss" aria-label="Dismiss suggestion" onClick={onDismiss}>{Icon.x()}</button>
        <button className="sx-b" title="Add to task list to start later" onClick={onAccept}>Add</button>
        <button className="sx-b soft" onClick={onStart}><PlayGlyph />Start</button>
      </div>
    </div>
  );
}

/**
 * One group in the tray: the header, then either its members (via
 * `renderItem`, so each surface draws its own card) or — after Start chain —
 * the composer. Stale groups start collapsed: they're leftovers, so the default
 * keeps them out of the way with the Stale tag saying why.
 */
export function SuggestionGroup({ group, variant, newSince, agents, running, onOpenParent, onDismiss, onAcceptAll, onStartOne, onAcceptOne, onLaunchChain, renderItem }: {
  group: Group;
  variant: "list" | "board";
  newSince: number;
  agents: AgentsBundle;
  running: Set<string>;
  onOpenParent: (id: string) => void;
  onDismiss: (ids: string[], label: string) => void;
  onAcceptAll: (ids: string[], start: boolean) => Promise<void>;
  onStartOne: (id: string) => void;
  onAcceptOne: (id: string) => void;
  onLaunchChain: (launch: ChainLaunch) => Promise<void>;
  /** `position` is the member's 1-based chain slot, or null when order carries no meaning. */
  renderItem: (task: TaskRow, position: number | null, groupTag: string | null) => ReactNode;
}) {
  const [open, setOpen] = useState(!group.stale);
  const [composingState, setComposing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const n = group.tasks.length;
  const ids = group.tasks.map((t) => t.id);
  const single = n === 1;
  // A chain needs two members — whatever's left after a launch can't be one.
  const composing = composingState && !single;
  const ordered = !single && isOrderedGroup(group.tasks);
  const tag = commonSuggestionTag(group.tasks);
  const newCount = countNewSuggestions(group.tasks, newSince);
  const parent = group.parent;
  const sourceName = parent ? parent.title : group.kind === "gone" ? "Deleted task" : "No source task";
  const toastLabel = parent ? `from “${parent.title}”` : "";

  const acceptAll = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try { await onAcceptAll(ids, false); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const folded = !showAll && n > ROWS_MAX;
  const visible = folded ? group.tasks.slice(0, ROWS_FOLDED) : group.tasks;
  const hidden = group.tasks.slice(visible.length);
  const unit = group.kind === "parent" ? "follow-up" : "suggestion";

  return (
    <section className={`sug-group sg-${variant} ${group.stale ? "is-stale" : ""} ${open ? "" : "is-collapsed"} ${composing ? "is-composing" : ""}`}>
      <header className="sug-head">
        <div className="sx-src">
          <button
            className="sx-chev" aria-expanded={open}
            onClick={() => { setOpen((o) => !o); setComposing(false); }}
            title={open ? "Collapse this group" : `Show ${n} ${unit}${single ? "" : "s"}`}
          >
            {Icon.chevDown({ style: { transform: open ? undefined : "rotate(-90deg)" } })}
          </button>
          <span className={`sx-k ${composing ? "on" : ""}`}>{composing ? "Chain" : "From"}</span>
          {parent ? (
            <button className="sx-t link" onClick={() => onOpenParent(parent.id)} title={`${suggestionGroupLabel(group)} — open the session that suggested these`}>
              <StatusDot status={parent.status} running={running.has(parent.id)} awaiting={isAwaiting(parent)} />
              <span className="t">{sourceName}</span>
            </button>
          ) : (
            <span className="sx-t dim" title={group.kind === "gone" ? "The task that proposed these has been deleted" : "No record of which session proposed these"}>
              <span className="t">{sourceName}</span>
            </span>
          )}
          {tag && <span className="sx-tag">{tag}</span>}
          {!open && <span className="sx-age" title={`Newest suggestion: ${clockTime(group.newestAt)}`}>{n} · {shortAge(group.newestAt)}</span>}
          {!open && group.stale && <span className="sx-stale" title={`Stale — ${group.staleReason}`}>Stale</span>}
        </div>
        {open && !composing && (
          <div className="sx-bar">
            <span className="sx-sum">
              <b>{n} {unit}{single ? "" : "s"}</b>
              {group.generation && group.generation > 0 ? ` · session ${group.generation}` : ""}
              {group.newestAt > 0 && <span title={`Newest suggestion: ${clockTime(group.newestAt)}`}> · {relTime(group.newestAt)}</span>}
            </span>
            {newCount > 0 && <span className="sh-new">{newCount} new</span>}
            {group.stale && <span className="sx-stale" title={`Stale — ${group.staleReason}`}>Stale</span>}
            <span className="sx-sp" />
            <button className="sx-b quiet" onClick={() => onDismiss(ids, toastLabel)} title={single ? "Dismiss this suggestion" : "Dismiss every suggestion in this group"}>
              {single ? "Dismiss" : "Dismiss all"}
            </button>
            {single ? (
              <>
                <button className="sx-b" onClick={() => onAcceptOne(ids[0])} title="Add to task list to start later">Add to list</button>
                <button className="sx-b soft" onClick={() => onStartOne(ids[0])}><PlayGlyph />Start</button>
              </>
            ) : (
              <>
                <button className="sx-b" disabled={busy} onClick={() => void acceptAll()} title="Add all of these to the task list">Accept all</button>
                <button className="sx-b pri" disabled={busy} onClick={() => setComposing(true)} title="Review order, then launch these as a chain"><ChainGlyph />Start chain</button>
              </>
            )}
          </div>
        )}
      </header>
      {error && <div role="alert" className="sx-err">{error}</div>}
      {open && composing && (
        <ChainComposer group={group} agents={agents} onCancel={() => setComposing(false)} onLaunch={onLaunchChain} />
      )}
      {open && !composing && (
        <>
          <div className={`sx-rows ${single ? "single" : ordered ? "ordered" : "unordered"}`}>
            {visible.map((t, i) => (
              <Fragment key={t.id}>{renderItem(t, single || ordered ? i + 1 : null, tag)}</Fragment>
            ))}
          </div>
          {folded && (
            <button className="sx-more" onClick={() => setShowAll(true)}>
              + {hidden.length} more
              <span>· {hidden.slice(0, 2).map((t) => parseSuggestionTitle(t.title).text).join(", ")}{hidden.length > 2 ? ", …" : ""}</span>
            </button>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Start chain → review before launch. Include/exclude members, drag (or
 * Alt+↑/↓ on the grip) to reorder, pick the agent, and choose when each next
 * task starts. The unselected stay in the tray untouched.
 */
function ChainComposer({ group, agents, onCancel, onLaunch }: {
  group: Group; agents: AgentsBundle; onCancel: () => void; onLaunch: (launch: ChainLaunch) => Promise<void>;
}) {
  const byId = new Map(group.tasks.map((t) => [t.id, t]));
  const [order, setOrder] = useState(() => group.tasks.map((t) => t.id));
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  // One agent for the whole chain; "" keeps each task's own (shown when they differ).
  const shared = group.tasks.every((t) => t.agent === group.tasks[0].agent) ? group.tasks[0].agent : "";
  const [agent, setAgent] = useState(shared);
  const [advance, setAdvance] = useState<ChainAdvance>("done");
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Tasks can be removed from the group underneath us (dismissed in another
  // tab); keep the local order to members that still exist.
  const live = order.filter((id) => byId.has(id));
  const selected = live.filter((id) => !excluded.has(id));
  const k = selected.length;
  const total = live.length;

  const move = (id: string, to: number) => setOrder((prev) => {
    const next = prev.filter((x) => x !== id);
    next.splice(Math.max(0, Math.min(to, next.length)), 0, id);
    return next;
  });
  const toggle = (id: string) => setExcluded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const launch = async (start: boolean) => {
    if (busy || !k) return;
    setBusy(true); setError("");
    try {
      await onLaunch({ groupIds: live, ordered: selected, agent: agent && agent !== shared ? agent : null, advance, start });
      // Excluded members stay behind as the group; they go back to the plain list.
      onCancel();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const rest = total - k;
  const restNote = rest > 0 ? ` The ${rest} unselected stay in suggestions.` : "";
  const hint = k === 0 ? "Select at least one task."
    : advance === "done"
      ? k === 1 ? `Task 1 starts now.${restNote}`
        : `Task 1 starts now. Each next task starts once the previous one is done (merging marks it done); the chain pauses if any step needs input.${restNote}`
      : `All ${k} start now, each in its own session and worktree.${restNote}`;

  let slot = 0;
  return (
    <>
      <div className="sx-cbar">
        <span className="sx-sum"><b>{k} of {total} selected</b> · drag to reorder</span>
        <span className="sx-sp" />
        <button className="sx-b quiet dim" onClick={() => setExcluded(k === total ? new Set(live) : new Set())}>
          {k === total ? "Select none" : "Select all"}
        </button>
      </div>
      <div className="sx-rows chain" onDragOver={(e) => e.preventDefault()}>
        {live.map((id, i) => {
          const t = byId.get(id)!;
          const off = excluded.has(id);
          const { text, priority } = parseSuggestionTitle(t.title);
          const pos = off ? null : ++slot;
          return (
            <Fragment key={id}>
              {drag && drag.id !== id && drag.over === i && <div className="sx-dropline" />}
              <div
                className={`sx-row ${off ? "excluded" : ""} ${drag?.id === id ? "dragging" : ""}`}
                draggable
                onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", id); setDrag({ id, over: i }); }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!drag) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  const over = e.clientY > r.top + r.height / 2 ? i + 1 : i;
                  if (over !== drag.over) setDrag({ ...drag, over });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (drag) move(drag.id, drag.over > live.indexOf(drag.id) ? drag.over - 1 : drag.over);
                  setDrag(null);
                }}
                onDragEnd={() => setDrag(null)}
              >
                <button className={`sx-chk ${off ? "off" : ""}`} role="checkbox" aria-checked={!off} aria-label={`Include “${text}”`} onClick={() => toggle(id)}>
                  {!off && <CheckGlyph />}
                </button>
                <div className="sx-node"><i>{pos ?? "–"}</i></div>
                <div className="sx-main"><div className="sx-rt"><span className="sg-name" title={t.title}>{text}</span><SxPill p={priority ?? t.priority} /></div></div>
                <button
                  className="sx-grip" aria-label={`Reorder “${text}” (Alt+Up / Alt+Down)`} title="Drag to reorder"
                  onKeyDown={(e) => {
                    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                    e.preventDefault();
                    move(id, e.key === "ArrowUp" ? i - 1 : i + 1);
                  }}
                >
                  <GripGlyph />
                </button>
              </div>
            </Fragment>
          );
        })}
        {drag && drag.over === live.length && <div className="sx-dropline" />}
      </div>
      <div className="sx-compose">
        <div className="sx-opt">
          <span className="k">Agent</span>
          {agents.agents.length > 1 ? (
            <select className="sx-sel" value={agent} onChange={(e) => setAgent(e.target.value)}>
              {!shared && <option value="">As suggested (mixed)</option>}
              {agents.agents.map((a) => (
                <option key={a.id} value={a.id} disabled={!a.authenticated && a.id !== shared}>
                  {a.label}{a.authenticated ? "" : " — not connected"}
                </option>
              ))}
            </select>
          ) : (
            <span className="sx-sel static">{agents.agents[0]?.label ?? "Default agent"}</span>
          )}
        </div>
        <div className="sx-opt">
          <span className="k">Advance on</span>
          <div className="sx-radio" role="radiogroup" aria-label="When the next task starts">
            <button role="radio" aria-checked={advance === "done"} className={advance === "done" ? "on" : ""} onClick={() => setAdvance("done")} title="Start each next task once the previous one is done — merging marks a task done">Done</button>
            <button role="radio" aria-checked={advance === "now"} className={advance === "now" ? "on" : ""} onClick={() => setAdvance("now")} title="Start every selected task right away, in parallel">Immediately</button>
          </div>
        </div>
        <div className="sx-hint">{hint}</div>
        {error && <div role="alert" className="sx-err">{error}</div>}
        <div className="sx-cacts">
          <button className="sx-b quiet dim" onClick={onCancel} disabled={busy}>Cancel</button>
          <span className="sx-sp" />
          <button className="sx-b" disabled={busy || !k} onClick={() => void launch(false)} title="Accept in this order without starting anything">Add {k} to list only</button>
          <button className="sx-b pri" disabled={busy || !k} onClick={() => void launch(true)}>
            <PlayGlyph />{advance === "done" && k > 1 ? `Start chain · ${k}` : `Start ${k}`}
          </button>
        </div>
      </div>
    </>
  );
}

/** Row-level helper for the list tray: titles of blockers OUTSIDE this group (the rail already shows in-group order). */
export function outsideBlockerTitles(task: TaskRow, group: Group, blockedBy: Map<string, string[]>): string[] {
  const inGroup = new Set(group.tasks.map((t) => t.title));
  return (blockedBy.get(task.id) ?? []).filter((title) => !inGroup.has(title));
}

