// Browser-history mechanics for the mobile projects → tasks → session panes,
// kept pure (no React, no globals) so the Back-button behaviour can be unit-tested.
//
// Why a "trap" instead of one-entry-per-level: the live task list re-selects the
// open task on every background refresh, so selTask churns null↔id constantly.
// Any scheme that pushes a history entry when the selection gets *deeper* turns
// that churn into a pile of duplicate session entries, and Back can never escape
// them (the original "back acts very strange / does nothing" bug on prod).
//
// Instead we keep at most ONE "trap" entry on top whenever a detail pane is open.
// Arming is keyed on the BOOLEAN "is a pane open" (isDeep), which selTask churn
// does not change — so churn only ever rewrites the current entry's URL, never
// adds entries. Back consumes the trap; the app then closes exactly one level
// (closeOneLevel) and re-arms, so Back walks session → tasks → projects → exit.
import type { View } from "./types";

export interface NavSel {
  proj: string | null;
  task: string | null;
  view: View;
}

// Minimal slice of window.history this logic needs — lets tests pass a fake.
export interface HistoryLike {
  readonly state: unknown;
  pushState(state: unknown, unused: string, url: string): void;
  replaceState(state: unknown, unused: string, url: string): void;
}

export function selectionUrl(sel: NavSel, pathname: string): string {
  const q = new URLSearchParams();
  if (sel.proj) q.set("project", sel.proj);
  if (sel.task) q.set("task", sel.task);
  if (sel.view === "settings" || sel.view === "insights") q.set("view", sel.view);
  const s = q.toString();
  return s ? `?${s}` : pathname;
}

// Deeper than the projects list? i.e. a detail pane (a project's task list, an
// open task, or settings) is showing and Back should close it rather than leave.
export const isDeep = (sel: NavSel): boolean => !!sel.proj || sel.view === "settings" || sel.view === "insights";

const trapArmed = (h: HistoryLike): boolean =>
  !!(h.state && (h.state as { trap?: unknown }).trap);

// Keep the URL mirrored to the current selection (so a refresh lands back where
// you were) and, when `armTrap`, ensure exactly one trap entry sits on top while
// a pane is open. armTrap is the caller's "is mobile" gate — on desktop all
// columns are visible at once, so Back should not hijack to close a panel.
export function reconcileHistory(h: HistoryLike, pathname: string, sel: NavSel, armTrap: boolean): void {
  const url = selectionUrl(sel, pathname);
  const armed = trapArmed(h);
  if (armTrap && isDeep(sel) && !armed) {
    // Entering a detail pane from a non-trap entry: arm the single trap.
    h.pushState({ trap: true }, "", url);
  } else {
    // Already armed (pane open — incl. selTask churn), or shallow/desktop: just
    // mirror the URL onto the current entry, preserving the trap flag.
    h.replaceState({ trap: armed }, "", url);
  }
}

// One Back press closes the deepest open level. Returns the selection to apply;
// at the projects root it returns the input unchanged (Back then leaves the app).
export function closeOneLevel(sel: NavSel): NavSel {
  if (sel.view === "settings" || sel.view === "insights") return { ...sel, view: "workspace" };
  if (sel.task) return { ...sel, task: null };
  if (sel.proj) return { ...sel, proj: null };
  return sel;
}
