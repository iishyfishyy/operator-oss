"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import type { GlobalTaskEvent } from "@/lib/types";
import { jget } from "./api";
import type { ProjectRow, TaskRow } from "./types";

// One always-open EventSource on GET /api/events: coarse lifecycle events for
// EVERY task across EVERY project (turn started / awaiting input / answered /
// suggestion created / turn ended). This is what clears spinners and updates
// the "needs you" badges for tasks whose transcript stream isn't open — only
// the selected task has one (useTaskStream) — replacing the old 10s poll.
export function useGlobalEvents({ selProjRef, setTaskRunning, setTasks, setProjects, loadTasks, reconcileRunning }: {
  selProjRef: MutableRefObject<string | null>;
  setTaskRunning: (id: string, on: boolean) => void;
  setTasks: React.Dispatch<React.SetStateAction<TaskRow[]>>;
  setProjects: React.Dispatch<React.SetStateAction<ProjectRow[]>>;
  loadTasks: (projectId: string, selectFirst?: boolean) => Promise<void>;
  reconcileRunning: () => Promise<void>;
}) {
  // Apply one lifecycle event. The payload is a fresh snapshot of the task
  // row's running/awaiting_input/status (read after the runner persisted it),
  // so applying it is idempotent — overlaps with the selected task's own
  // stream, which fires for the same boundaries, are harmless.
  const handle = (ev: GlobalTaskEvent) => {
    if (ev.type !== "task") return;
    setTaskRunning(ev.taskId, ev.running);
    setTasks((prev) => prev.map((t) => {
      if (t.id !== ev.taskId) return t;
      // A launch publishes turn_started before the agent session opens, i.e.
      // while the row's status is still "not_started" — don't regress a task
      // the client already optimistically flipped to in_progress; the session-
      // open event re-fires turn_started with the settled status moments later.
      const status = ev.running && ev.status === "not_started" && t.status === "in_progress" ? t.status : ev.status;
      return { ...t, running: ev.running ? 1 : 0, awaiting_input: ev.awaiting_input ? 1 : 0, status };
    }));
    // Project badge + titlebar pill: the event carries the project's fresh
    // awaiting count, so no /api/projects refetch is needed.
    setProjects((prev) => prev.map((p) => (p.id === ev.projectId ? { ...p, awaiting_count: ev.awaiting_count } : p)));
    // A suggested task was created (by a turn in that project) — surface it in
    // the Suggested tray right away if that project is on screen.
    if (ev.event === "suggested" && selProjRef.current === ev.projectId) void loadTasks(ev.projectId, false);
  };
  // Route through a ref so the EventSource effect never re-subscribes.
  const handleRef = useRef(handle);
  useEffect(() => { handleRef.current = handle; });

  useEffect(() => {
    const es = new EventSource("/api/events");
    let opens = 0;
    es.onopen = () => {
      // This stream is a live tail with no snapshot: anything published while
      // we were disconnected (laptop sleep, tunnel drop) is gone. On every
      // REconnect, refetch the authoritative lists once to catch up. The first
      // open is skipped — boot() and the project-selection effect already load
      // them. reconcileRunning drains the running set fleet-wide: a turn_end
      // missed while dark, on a task in a project we've navigated away from,
      // is invisible to the two refetches below (they only cover the selected
      // project's rows) and would leave that spinner stuck forever.
      opens += 1;
      if (opens === 1) return;
      jget<ProjectRow[]>("/api/projects").then(setProjects).catch(() => {});
      if (selProjRef.current) void loadTasks(selProjRef.current, false);
      void reconcileRunning();
    };
    es.onmessage = (e) => {
      try { handleRef.current(JSON.parse(e.data) as GlobalTaskEvent); } catch {}
    };
    return () => es.close();
    // All deps are stable (a ref, a setState, []-memoized callbacks).
  }, [selProjRef, setProjects, loadTasks, reconcileRunning]);
}
