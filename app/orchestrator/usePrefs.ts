"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { LS, loadPersist } from "./persist";
import { reconcileHistory, closeOneLevel, type NavSel } from "./navHistory";
import {
  DEFAULT_APPEARANCE, DEFAULT_SETTINGS, DEFAULT_LAYOUT,
  type Appearance, type Settings, type Layout, type View, type TaskView,
} from "./types";

// Mirror of Orchestrator's mobile breakpoint — the Back-button trap only arms on
// mobile (single-pane), since on desktop every column is visible and Back should
// not be hijacked to close a panel.
const MOBILE_QUERY = "(max-width: 760px)";

// Owns the cosmetic/client-only preferences (appearance, settings, layout) and the
// active work-area view, plus the hydrate-once + persist/URL-sync effects. The
// open project/task are passed in so they get mirrored into localStorage + URL
// alongside the prefs (URL keeps a refresh landing where you were). The setters
// are passed in so the Back button (popstate) can close one pane level — on
// mobile this is the only way to step session → tasks → projects.
export function usePrefs({ selProj, selTask, urlSelRef, setSelProj, setSelTask }: {
  selProj: string | null;
  selTask: string | null;
  urlSelRef: MutableRefObject<{ project?: string; task?: string; view?: string } | null>;
  setSelProj: (id: string | null) => void;
  setSelTask: (id: string | null) => void;
}) {
  const [view, setView] = useState<View>("workspace");
  const [taskView, setTaskView] = useState<TaskView>("list");
  const [appearance, setAppearance] = useState<Appearance>(DEFAULT_APPEARANCE);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
  // Per-project "last time I looked at the suggestion tray" marks (ms epoch).
  // Suggestions created after a project's mark render as "new"; seeing the tray
  // advances it (see useTrayView in SuggestionGroup.tsx).
  const [traySeen, setTraySeen] = useState<Record<string, number>>({});
  const [hydrated, setHydrated] = useState(false);

  // Latest selection, read by the once-attached popstate handler without
  // re-subscribing. Updated every render (cheap, and refs are render-safe here).
  const selRef = useRef<NavSel>({ proj: selProj, task: selTask, view });
  selRef.current = { proj: selProj, task: selTask, view };

  // hydrate persisted prefs once
  useEffect(() => {
    const p = loadPersist();
    if (p.appearance) setAppearance({ ...DEFAULT_APPEARANCE, ...p.appearance });
    if (p.settings) setSettings({ ...DEFAULT_SETTINGS, ...p.settings });
    if (p.layout) setLayout({ ...DEFAULT_LAYOUT, ...p.layout });
    if (p.taskView === "board") setTaskView("board");
    if (p.traySeen) setTraySeen(p.traySeen);
    const urlView = urlSelRef.current?.view;
    if (urlView === "settings" || urlView === "insights") setView(urlView);
    setHydrated(true);
  }, [urlSelRef]);

  // persist + apply appearance
  useEffect(() => {
    if (!hydrated) return;
    document.documentElement.setAttribute("data-theme", appearance.theme);
    document.documentElement.style.setProperty("--density", appearance.density);
    localStorage.setItem(LS, JSON.stringify({ selProj, selTask, appearance, settings, layout, taskView, traySeen }));

    // Mirror the open project/task + active view into the URL (refresh-restore)
    // and, on mobile, keep a single Back-trap entry on top while a pane is open
    // so the device Back button steps session → tasks → projects. (See navHistory.)
    const armTrap = window.matchMedia(MOBILE_QUERY).matches;
    reconcileHistory(window.history, window.location.pathname, { proj: selProj, task: selTask, view }, armTrap);
  }, [appearance, settings, layout, taskView, traySeen, selProj, selTask, view, hydrated]);

  // Back button: consume the trap and close exactly one pane level. The setState
  // calls re-run the persist effect, which re-arms the trap if a pane is still
  // open (pushState fires no popstate, so no loop). Driving off the live
  // selection — not the popped URL — makes this immune to the task list churning
  // selTask, which would otherwise leave stale duplicate history entries.
  useEffect(() => {
    const onPop = () => {
      const next = closeOneLevel(selRef.current);
      setSelProj(next.proj);
      setSelTask(next.task);
      setView(next.view);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [setSelProj, setSelTask]);

  // Record that the project's tray has been seen. No-ops when the mark wouldn't
  // move forward, so a repeat call can't churn state (or clobber a later mark
  // written by another tab's tray).
  const markTrayViewed = useCallback((projectId: string, at: number = Date.now()) => {
    setTraySeen((prev) => (prev[projectId] >= at ? prev : { ...prev, [projectId]: at }));
  }, []);

  const setAppearanceKey = (k: keyof Appearance, v: string) => setAppearance((a) => ({ ...a, [k]: v }));
  const setSetting = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings((s) => ({ ...s, [k]: v }));

  return { view, setView, taskView, setTaskView, appearance, setAppearance: setAppearanceKey, settings, setSetting, setSettings, layout, setLayout, traySeen, markTrayViewed, hydrated };
}
