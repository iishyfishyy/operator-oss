"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { LS, loadPersist } from "./persist";
import { reconcileHistory, closeOneLevel, type NavSel } from "./navHistory";
import {
  DEFAULT_TWEAKS, DEFAULT_SETTINGS, DEFAULT_LAYOUT,
  type Tweaks, type Settings, type Layout, type View,
} from "./types";

// Mirror of Orchestrator's mobile breakpoint — the Back-button trap only arms on
// mobile (single-pane), since on desktop every column is visible and Back should
// not be hijacked to close a panel.
const MOBILE_QUERY = "(max-width: 760px)";

// Owns the cosmetic/client-only preferences (tweaks, settings, layout) and the
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
  const [tweaks, setTweaks] = useState<Tweaks>(DEFAULT_TWEAKS);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
  const [hydrated, setHydrated] = useState(false);

  // Latest selection, read by the once-attached popstate handler without
  // re-subscribing. Updated every render (cheap, and refs are render-safe here).
  const selRef = useRef<NavSel>({ proj: selProj, task: selTask, view });
  selRef.current = { proj: selProj, task: selTask, view };

  // hydrate persisted prefs once
  useEffect(() => {
    const p = loadPersist();
    if (p.tweaks) setTweaks({ ...DEFAULT_TWEAKS, ...p.tweaks });
    if (p.settings) setSettings({ ...DEFAULT_SETTINGS, ...p.settings });
    if (p.layout) setLayout({ ...DEFAULT_LAYOUT, ...p.layout });
    const urlView = urlSelRef.current?.view;
    if (urlView === "settings" || urlView === "insights") setView(urlView);
    setHydrated(true);
  }, [urlSelRef]);

  // persist + apply tweaks
  useEffect(() => {
    if (!hydrated) return;
    document.documentElement.setAttribute("data-theme", tweaks.theme);
    // "default" → let the theme's own accent (from CSS) stand; a custom swatch
    // overrides it inline. Clearing the property when default avoids a stale
    // inline accent surviving a theme switch.
    if (tweaks.accent && tweaks.accent !== "default") document.documentElement.style.setProperty("--accent", tweaks.accent);
    else document.documentElement.style.removeProperty("--accent");
    document.documentElement.style.setProperty("--density", tweaks.density);
    document.body.classList.toggle("status-labels", tweaks.statusStyle === "label");
    localStorage.setItem(LS, JSON.stringify({ selProj, selTask, tweaks, settings, layout }));

    // Mirror the open project/task + active view into the URL (refresh-restore)
    // and, on mobile, keep a single Back-trap entry on top while a pane is open
    // so the device Back button steps session → tasks → projects. (See navHistory.)
    const armTrap = window.matchMedia(MOBILE_QUERY).matches;
    reconcileHistory(window.history, window.location.pathname, { proj: selProj, task: selTask, view }, armTrap);
  }, [tweaks, settings, layout, selProj, selTask, view, hydrated]);

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

  const setTweak = (k: keyof Tweaks, v: string) => setTweaks((t) => ({ ...t, [k]: v }));
  const setSetting = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings((s) => ({ ...s, [k]: v }));

  return { view, setView, tweaks, setTweak, settings, setSetting, setSettings, layout, setLayout, hydrated };
}
