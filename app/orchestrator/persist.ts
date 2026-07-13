// localStorage + URL persistence for the open project/task, layout and prefs.
import type { Tweaks, Layout, Settings } from "./types";

export const LS = "orchestrator_ui_v2";

export function loadPersist(): { selProj?: string; selTask?: string; tweaks?: Tweaks; layout?: Layout; settings?: Settings } {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(LS) || "{}"); } catch { return {}; }
}

// The open project/task live in the URL query (?project=…&task=…) so a refresh
// lands back where you were and the view is shareable. URL wins over localStorage.
export function readUrlSel(): { project?: string; task?: string; view?: string } {
  if (typeof window === "undefined") return {};
  const q = new URLSearchParams(window.location.search);
  return { project: q.get("project") ?? undefined, task: q.get("task") ?? undefined, view: q.get("view") ?? undefined };
}
