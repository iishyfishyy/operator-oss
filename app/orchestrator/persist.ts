// localStorage + URL persistence for the open project/task, layout and prefs.
import type { Appearance, Layout, Settings, TaskView } from "./types";

export const LS = "orchestrator_ui_v2";

// `traySeen` is the per-project "last time I looked at the suggestion tray" mark
// (ms epoch, keyed by project id). Purely a read-marker for the "new" pills, so
// it lives here rather than in the DB — losing it costs one round of stale pills,
// not data, and it must not cost a server round trip on every tray render.
type Persisted = { selProj?: string; selTask?: string; appearance?: Partial<Appearance>; layout?: Layout; settings?: Settings; taskView?: TaskView; traySeen?: Record<string, number> };

export function loadPersist(): Persisted {
  if (typeof window === "undefined") return {};
  try {
    // `appearance` used to be called `tweaks` — read the legacy key so an existing
    // install keeps its theme/density across the rename (dropped fields are ignored
    // by the DEFAULT_APPEARANCE spread at the call site).
    const raw = JSON.parse(localStorage.getItem(LS) || "{}") as Persisted & { tweaks?: Partial<Appearance> };
    if (!raw.appearance && raw.tweaks) raw.appearance = raw.tweaks;
    return raw;
  } catch { return {}; }
}

// The open project/task live in the URL query (?project=…&task=…) so a refresh
// lands back where you were and the view is shareable. URL wins over localStorage.
export function readUrlSel(): { project?: string; task?: string; view?: string } {
  if (typeof window === "undefined") return {};
  const q = new URLSearchParams(window.location.search);
  return { project: q.get("project") ?? undefined, task: q.get("task") ?? undefined, view: q.get("view") ?? undefined };
}
