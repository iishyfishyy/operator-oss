"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../icons";
import { clockTime, shortAge } from "./format";
import { countNewSuggestions, suggestionGroupLabel, type SuggestionGroup as Group } from "./suggestions";

// The one suggestion-group header, shared by both tray surfaces (the list
// column's tray and the board's Suggested column). Everything that answers
// "should I care about this pile?" lives here — who proposed it, how old it is,
// how much of it is new since you last looked, and whether it's a leftover from
// a session that has since finished — so the two surfaces can't disagree.

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

/**
 * One group in the tray: the header, and (unless collapsed) whatever the caller
 * renders for its members. Stale groups start collapsed — they're leftovers, so
 * the default is to keep them out of the way with one line saying why and a
 * bulk dismiss, rather than to make you close them one at a time.
 */
export function SuggestionGroup({ group, variant, newSince, onOpenParent, onDismissAll, onAcceptAll, blockedBy, children }: {
  group: Group;
  variant: "list" | "board";
  newSince: number;
  onOpenParent: (id: string) => void;
  onDismissAll: (ids: string[]) => void;
  onAcceptAll: (ids: string[], start: boolean) => Promise<void>;
  blockedBy: Map<string, string[]>;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(!group.stale);
  // Hard delete, no undo (see CLAUDE.md) — so "Dismiss all" arms first and
  // deletes on the second click, the same one-step confirm the edit modal uses.
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (start: boolean) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await onAcceptAll(group.tasks.map((t) => t.id), start); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const n = group.tasks.length;
  const newCount = countNewSuggestions(group.tasks, newSince);
  const label = suggestionGroupLabel(group);
  const parent = group.parent;

  return (
    <div className={`sug-group sg-${variant} ${group.stale ? "is-stale" : ""} ${open ? "" : "is-collapsed"}`}>
      <div className="sug-head">
        <button
          className="sh-toggle" aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          title={open ? `Collapse ${label}` : `Show ${n} suggestion${n === 1 ? "" : "s"}`}
        >
          {Icon.chevDown({ className: "sh-chev" })}
        </button>
        {parent ? (
          <button className="sh-txt link" onClick={() => onOpenParent(parent.id)} title={`Open “${parent.title}” — the session that suggested these`}>
            {label}
          </button>
        ) : (
          <span className="sh-txt" title={group.kind === "gone" ? "The task that proposed these has been deleted" : "No record of which session proposed these"}>{label}</span>
        )}
        {group.newestAt > 0 && (
          <span className="sh-age" title={`Newest suggestion: ${clockTime(group.newestAt)}`}>{shortAge(group.newestAt)}</span>
        )}
        {newCount > 0 && <span className="sh-new">{newCount} new</span>}
        <span className="sh-count">{n}</span>
      </div>
      <div className="sh-actions">
        <button disabled={busy} onClick={() => void submit(false)}>Accept all ({n})</button>
        <button disabled={busy} onClick={() => void submit(true)}>Start chain</button>
      </div>
      {error && <div role="alert" className="sh-chain">{error}</div>}
      {open && <ol className="sh-chain" aria-label="Chain order">
        {group.tasks.map((t) => <li key={t.id}>
          {t.title}
          {!!blockedBy.get(t.id)?.length && <span> ← blocked by {blockedBy.get(t.id)!.join(", ")}</span>}
        </li>)}
      </ol>}
      {group.stale && (
        <div className="sh-stale">
          <span className="ss-why" title={`Stale — ${group.staleReason}`}>Stale — {group.staleReason}</span>
          {confirming ? (
            <button className="ss-drop on" onClick={() => onDismissAll(group.tasks.map((t) => t.id))} title="Permanently delete these suggestions — there's no undo">
              Delete {n}?
            </button>
          ) : (
            <button className="ss-drop" onClick={() => setConfirming(true)} title="Dismiss every suggestion in this group">
              Dismiss all
            </button>
          )}
        </div>
      )}
      {open && children}
    </div>
  );
}
