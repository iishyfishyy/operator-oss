"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Priority, Status, AskQuestion, AskAnswers } from "@/lib/types";
import type { ResolveResult } from "../TaskChanges";
import { jget, jsend } from "./api";
import { isAwaiting, blockerTitles, formatAnswersText } from "./format";
import { loadPersist, readUrlSel } from "./persist";
import { DEFAULT_SETTINGS, EMPTY_AGENTS, type AgentsBundle, type OnboardingT, type ProjectRow, type TaskRow } from "./types";
import { agentLabel } from "./agents";
import { useTaskStream } from "./useTaskStream";
import { useGlobalEvents } from "./useGlobalEvents";
import { usePrefs } from "./usePrefs";
import { useRecaps } from "./useRecaps";

type Modal = null | "task" | "context" | "project" | "sessions";

// The orchestrator's single source of truth: all client state, the derived
// views over it, the data-loading effects, and every action callback. Returns a
// flat bag the composition root (Orchestrator.tsx) wires straight into the UI.
export function useOrchestrator() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [selProj, setSelProj] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [selTask, setSelTask] = useState<string | null>(null);
  // First-paint state: booted flips once the initial project fetch lands, so the
  // shell can show a column skeleton instead of a blank flash; a failed boot
  // surfaces as a retryable error screen instead of an empty workspace.
  const [booted, setBooted] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  // Which project the current `tasks` array actually belongs to — until it
  // matches the selected project, the tasks column shows a skeleton rather than
  // the previous project's (stale) list.
  const [tasksFor, setTasksFor] = useState<string | null>(null);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<Modal>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [termOpen, setTermOpen] = useState(false);
  const [termMounted, setTermMounted] = useState(false); // mount once, then keep alive across collapses
  const [termHeight, setTermHeight] = useState(300);
  // Managed-services drawer — same mount-once-keep-alive pattern as the terminal.
  const [servicesOpen, setServicesOpen] = useState(false);
  const [servicesMounted, setServicesMounted] = useState(false);
  const [servicesHeight, setServicesHeight] = useState(300);
  // Server-backed app defaults (e.g. default reasoning / permission mode a task
  // inherits). Stored in orchestrator.db, not localStorage, so runTurn can read them.
  const [appDefaults, setAppDefaults] = useState<Record<string, string>>({});
  // Agent capability descriptors (GET /api/agents): the model/reasoning/permission
  // pickers, per-task agent badges, cost/ask gates, and the new-task agent picker
  // all read from this — no hardcoded per-agent lists in the client.
  const [agents, setAgents] = useState<AgentsBundle>(EMPTY_AGENTS);
  // First-run onboarding. `onboarding` is the persisted wizard state (resume
  // point + connection); `wizardOpen` mounts the full-screen wizard over the app.
  const [onboarding, setOnboarding] = useState<OnboardingT | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  // Shown after the built-in tutorial task is merged — the "now build your own" nudge.
  const [nudge, setNudge] = useState(false);

  const project = useMemo(() => projects.find((p) => p.id === selProj) ?? null, [projects, selProj]);
  const activeProjects = useMemo(() => projects.filter((p) => !p.deprecated), [projects]);
  const deprecatedProjects = useMemo(() => projects.filter((p) => p.deprecated), [projects]);
  const realTasks = useMemo(() => tasks.filter((t) => !t.suggested), [tasks]);
  const suggested = useMemo(() => tasks.filter((t) => t.suggested), [tasks]);
  const task = useMemo(() => tasks.find((t) => t.id === selTask) ?? null, [tasks, selTask]);
  // taskId -> titles of its unfinished blockers. A task in this map is blocked:
  // it shows a "Blocked by" chip and its Start button is disabled. Recomputed from
  // the live task list, so a blocker hitting 'done' auto-unblocks dependents.
  const tasksById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const blockedBy = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const t of tasks) {
      const names = blockerTitles(t, tasksById);
      if (names.length) m.set(t.id, names);
    }
    return m;
  }, [tasks, tasksById]);

  // Cross-project "Needs you" surfacing. The selected project's tasks are live in
  // state (so its count reflects awaiting_input as it changes mid-turn); other
  // projects come from the server-computed awaiting_count on the project list.
  const liveAwaiting = useMemo(() => realTasks.filter((t) => isAwaiting(t)), [realTasks]);
  const needsYouTotal = useMemo(
    () => activeProjects.reduce((n, p) => n + (p.id === selProj ? liveAwaiting.length : p.awaiting_count), 0),
    [activeProjects, selProj, liveAwaiting]
  );

  const setTaskRunning = (id: string, on: boolean) =>
    setRunning((prev) => { const n = new Set(prev); on ? n.add(id) : n.delete(id); return n; });

  // Capture the URL selection synchronously on first render. The URL-sync effect
  // runs (once `hydrated` flips) before the async project fetch applies selection,
  // and would wipe the query string while selProj/selTask are still null — so we
  // must read ?project/?task before that happens, not inside the fetch callback.
  const urlSelRef = useRef<{ project?: string; task?: string; view?: string } | null>(null);
  if (urlSelRef.current === null) urlSelRef.current = readUrlSel();

  // selProjRef tracks selProj for callbacks/intervals that must read the latest
  // value without re-subscribing (the live stream handler + the recap sweep).
  const selProjRef = useRef(selProj);
  useEffect(() => { selProjRef.current = selProj; }, [selProj]);

  // Latest agents bundle for the live stream handler (context-window sizing),
  // read without re-subscribing the EventSource.
  const agentsRef = useRef(agents);
  useEffect(() => { agentsRef.current = agents; }, [agents]);

  const loadTasks = useCallback(async (projectId: string, selectFirst = true) => {
    const data = await jget<{ tasks: TaskRow[] }>(`/api/projects/${projectId}`);
    setTasks(data.tasks);
    setTasksFor(projectId);
    if (selectFirst) {
      const first = data.tasks.find((t) => !t.suggested);
      setSelTask(first ? first.id : null);
    }
    // Reconcile the running set only against THIS project's tasks — add/remove
    // ids it actually fetched. A partial per-project view must never imply that
    // tasks it can't see (running in other projects) have stopped; those are
    // cleared authoritatively by reconcileRunning() below.
    setRunning((prev) => { const n = new Set(prev); for (const t of data.tasks) t.running ? n.add(t.id) : n.delete(t.id); return n; });
  }, []);

  // Authoritative fleet-wide reconciliation of the running set. Cross-project
  // turn boundaries normally arrive on the global /api/events stream — but if
  // that stream was disconnected (laptop sleep, tunnel drop) when a turn ended,
  // the event is gone and the spinner would stick forever: the client only
  // refetches the SELECTED project's rows, so no other path would ever clear
  // it. useGlobalEvents calls this on every SSE reconnect; replacing the whole
  // set with the server's global truth drains any stale entries.
  const reconcileRunning = useCallback(async () => {
    try { const { ids } = await jget<{ ids: string[] }>("/api/running"); setRunning(new Set(ids)); } catch {}
  }, []);

  // ---------- live task event stream + transcript state ----------
  const { msgsByTask, appendMsg, setAnswerOnMsg } = useTaskStream({
    selTask, selProjRef, agentsRef, setTaskRunning, setTasks, setProjects, loadTasks,
  });
  // Always-open global lifecycle stream (GET /api/events): keeps spinners,
  // project badges, and the "N need you" pill live for tasks whose transcript
  // stream ISN'T open — only the selected task has one.
  useGlobalEvents({ selProjRef, setTaskRunning, setTasks, setProjects, loadTasks, reconcileRunning });
  const messages = selTask ? msgsByTask[selTask] ?? [] : [];
  // No entry yet for the selected task = its SSE snapshot hasn't arrived — the
  // session view shows a transcript skeleton instead of an empty chat flash.
  const transcriptLoading = !!selTask && !(selTask in msgsByTask);
  // The tasks in state still belong to the previously selected project.
  const tasksLoading = !!project && tasksFor !== project.id;

  // ---------- prefs (appearance/settings/layout/view) + persistence ----------
  const { view, setView, appearance, setAppearance, settings, setSetting, setSettings, layout, setLayout, hydrated } =
    usePrefs({ selProj, selTask, urlSelRef, setSelProj, setSelTask });

  // ---------- project recaps + landing decision ----------
  const { recaps, fetchRecap } = useRecaps({ selProj, selTask, tasks, setSelTask, selProjRef });

  // Load server-backed app defaults (reasoning / permission mode) once.
  useEffect(() => {
    jget<Record<string, string>>("/api/settings").then(setAppDefaults).catch(() => {});
  }, []);

  // Load the agent capability bundle once (drives every run-control picker).
  useEffect(() => {
    jget<AgentsBundle>("/api/agents").then(setAgents).catch(() => {});
  }, []);

  // Onboarding: a fresh instance opens the wizard automatically; an already
  // set-up one (onboarding_complete) never sees it unless re-run from Settings.
  useEffect(() => {
    jget<OnboardingT>("/api/onboarding").then((o) => { setOnboarding(o); if (!o.complete) setWizardOpen(true); }).catch(() => {});
  }, []);

  const finishWizard = useCallback(() => {
    setWizardOpen(false);
    jget<OnboardingT>("/api/onboarding").then(setOnboarding).catch(() => {});
    // Land the user on the built-in tutorial: select the seeded "Welcome" project
    // and its ready "Try me" task (loadTasks(..., true) picks the first
    // non-suggested task), so the aha moment is one click away.
    const seed = projects.find((p) => p.seeded && !p.deprecated) ?? activeProjects[0];
    if (seed) {
      setSelProj(seed.id);
      setView("workspace");
      void loadTasks(seed.id, true);
    }
  }, [projects, activeProjects, loadTasks, setView]);

  // "Re-run setup" from Settings: re-arm onboarding server-side and reopen it.
  const rerunOnboarding = useCallback(async () => {
    const o = await jsend<OnboardingT>("/api/onboarding", "DELETE");
    setOnboarding(o);
    setView("workspace");
    setWizardOpen(true);
  }, [setView]);

  // Who unlocked this instance (Cloudflare Access identity, shown in the
  // titlebar). null when enforcement is off — e.g. local dev — hides the chip.
  const [accessEmail, setAccessEmail] = useState<string | null>(null);
  useEffect(() => {
    jget<{ email: string | null }>("/api/me").then((r) => setAccessEmail(r.email)).catch(() => {});
  }, []);

  // initial load (also the Retry target when the first fetch fails)
  const boot = useCallback(() => {
    setBootError(null);
    jget<ProjectRow[]>("/api/projects").then((ps) => {
      setProjects(ps);
      const persisted = loadPersist();
      const url = urlSelRef.current ?? {};
      const active = ps.filter((p) => !p.deprecated);
      const wantProj = url.project ?? persisted.selProj;
      const wantTask = url.task ?? persisted.selTask;
      // Never land on a deprecated project — it must be restored before building.
      const persistedActive = active.find((p) => p.id === wantProj)?.id;
      const landProj = persistedActive ?? active[0]?.id ?? null;
      setSelProj(landProj);
      // Restore the task only if it belongs to the project we actually land on.
      // (If wantProj was missing/deprecated we fell back to active[0] — don't
      // carry over a task from a different project.) Validity within the project
      // is checked once its tasks load, below.
      if (wantTask && landProj === wantProj) setSelTask(wantTask);
      setBooted(true);
    }).catch((e) => {
      setBootError(e instanceof Error ? e.message : String(e));
    });
  }, []);
  useEffect(() => { boot(); }, [boot]);

  // Entering a project loads its tasks but does NOT auto-pick one — the landing
  // decision (recap vs. first task) is made in useRecaps once recap status is known.
  useEffect(() => { if (selProj) loadTasks(selProj, false); }, [selProj, loadTasks]);

  // Browser notification when a task newly needs you — the payoff for the
  // permission asked for during onboarding. Fires on the awaiting transition
  // (a turn ending mid-task OR Claude parking on a question), for any task in
  // the current project. We seed the "already notified" set without firing so a
  // page load / project switch doesn't alert for tasks that were already
  // waiting, and skip the task you're actively looking at.
  const notifiedRef = useRef<Set<string> | null>(null);
  useEffect(() => { notifiedRef.current = null; }, [selProj]); // re-seed per project; declared before the firing effect so it runs first
  useEffect(() => {
    const ids = new Set(liveAwaiting.map((t) => t.id));
    if (notifiedRef.current === null) { notifiedRef.current = ids; return; }
    const seen = notifiedRef.current;
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
      for (const t of liveAwaiting) {
        if (seen.has(t.id)) continue;
        // You're already staring at it — no need to interrupt.
        if (t.id === selTask && document.visibilityState === "visible") continue;
        const n = new Notification(`${agentLabel(agents, t.agent)} needs your input`, { body: t.title, tag: `await-${t.id}` });
        n.onclick = () => { window.focus(); setSelTask(t.id); n.close(); };
      }
    }
    notifiedRef.current = ids;
  }, [liveAwaiting, selTask, agents]);

  // Persist a server-backed app default and adopt the server's echoed-back state.
  const setAppDefault = async (key: string, value: string | null) => {
    const fresh = await jsend<Record<string, string>>("/api/settings", "PATCH", { [key]: value });
    setAppDefaults(fresh);
  };

  // ---------- sending a turn ----------
  // POST hands the turn to a detached server-side runner and returns at once;
  // everything that happens next (including the user-message echo) arrives
  // over the task's event stream. A reload mid-turn no longer kills it.
  const runTurn = useCallback(async (taskId: string, text: string, isInitial: boolean) => {
    setTaskRunning(taskId, true);
    setTasks((prev) => prev.map((x) => (x.id === taskId ? { ...x, started: 1, status: "in_progress", suggested: 0, awaiting_input: 0 } : x)));
    try {
      const res = await fetch(`/api/tasks/${taskId}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      if (!res.ok) {
        const raw = await res.text(); let msg = raw;
        try { msg = JSON.parse(raw).error ?? raw; } catch {}
        throw new Error(msg);
      }
    } catch (err) {
      setTaskRunning(taskId, false);
      appendMsg(taskId, { id: `e-${Date.now()}`, role: "system", content: err instanceof Error ? err.message : String(err), generation: tasks.find((t) => t.id === taskId)?.generation ?? 1 });
      try { const fresh = await jget<TaskRow>(`/api/tasks/${taskId}`); setTasks((prev) => prev.map((x) => (x.id === taskId ? { ...x, ...fresh } : x))); } catch {}
    }
  }, [tasks, appendMsg]);

  // Submit the user's answer to an AskUserQuestion. In the common case the live
  // turn is parked waiting and continues in its existing stream (resolved:true).
  // If nothing was waiting (e.g. the turn was torn down by a page reload), resume
  // the session with the answer as a normal reply.
  const answerQuestion = useCallback(async (taskId: string, askId: string, questions: AskQuestion[], answers: AskAnswers) => {
    setAnswerOnMsg(taskId, askId, answers); // optimistic — the stream echoes ask_answered
    try {
      // No tool_use id to resolve against — e.g. a question persisted before
      // ask-id tracking was added, or one whose turn was already torn down. The
      // /answer route requires a non-empty askId, so skip it and just send the
      // choices as a normal reply, which resumes the current session.
      if (!askId) { await runTurn(taskId, formatAnswersText(questions, answers), false); return; }
      const { resolved } = await jsend<{ resolved: boolean }>(`/api/tasks/${taskId}/answer`, "POST", { askId, answers });
      if (!resolved) await runTurn(taskId, formatAnswersText(questions, answers), false);
    } catch (err) {
      appendMsg(taskId, { id: `e-${Date.now()}`, role: "system", content: err instanceof Error ? err.message : String(err), generation: tasks.find((t) => t.id === taskId)?.generation ?? 1 });
    }
  }, [runTurn, tasks, appendMsg, setAnswerOnMsg]);

  // Interrupt a running turn — the ONLY way one stops early now that turns are
  // detached from connections. The server aborts the SDK query, persists the
  // partial transcript, and publishes turn_end, which the event stream handler
  // turns into a task refresh (now awaiting_input, resumable).
  const stopTurn = useCallback(async (taskId: string) => {
    try { await fetch(`/api/tasks/${taskId}/abort`, { method: "POST" }); } catch {}
  }, []);

  // Drop a queued (not-yet-run) follow-up. The server publishes `dequeued`,
  // which the stream handler turns into removing the bubble — so this is
  // fire-and-forget; no optimistic local mutation needed.
  const cancelQueued = useCallback(async (taskId: string, pendingId: string) => {
    try { await fetch(`/api/tasks/${taskId}/pending`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pendingId }) }); } catch {}
  }, []);

  // Materialize a conflicted merge in the task's worktree, then stream an AI
  // resolution turn into the transcript. Returns enough for TaskChanges to show
  // the right follow-up (review state, clean-merge done, or an error).
  const resolveConflictsWithAI = useCallback(async (taskId: string): Promise<ResolveResult> => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/merge/prepare`, { method: "POST" });
      const prep = await res.json();
      if (!res.ok || !prep?.ok) return { ok: false, error: prep?.error || "could not prepare the merge" };
      // Clean trial merge — it landed immediately, no AI needed.
      if (prep.clean) {
        if (selProj) loadTasks(selProj, false);
        try { const fresh = await jget<TaskRow>(`/api/tasks/${taskId}`); setTasks((prev) => prev.map((x) => (x.id === taskId ? { ...x, ...fresh } : x))); } catch {}
        return prep.merged?.ok ? { ok: true, merged: true } : { ok: false, error: prep.merged?.error || "merge failed" };
      }
      // Conflicts present — stream the resolution turn (shows in the transcript).
      // Fire-and-forget: the caller switches to the chat view as soon as this
      // returns, so the user watches the resolution stream in live rather than
      // sitting on the "Changes" tab until the whole turn completes.
      void runTurn(taskId, prep.prompt, false);
      return { ok: true, conflicts: prep.conflicts, binaryConflicts: prep.binaryConflicts };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }, [runTurn, selProj, loadTasks]);

  // A merge just landed. Refresh the task list so its merged state shows, and —
  // if this was the tutorial (a task in the seeded Welcome project) — fire the
  // "now build your own" nudge, the payoff for finishing the loop.
  const onMerged = useCallback(() => {
    if (selProj) void loadTasks(selProj, false);
    if (project?.seeded) setNudge(true);
  }, [selProj, loadTasks, project]);

  // A PR was just opened (or updated) for a task. Refresh the task list so the
  // header's PR chip picks up the stored URL without waiting for the next poll.
  const onPrCreated = useCallback(() => {
    if (selProj) void loadTasks(selProj, false);
  }, [selProj, loadTasks]);

  // ---------- actions ----------
  const selectProject = (id: string) => { setSelProj(id); setSelTask(null); setView("workspace"); };

  // Jump to the next task waiting on the user: prefer one in the current project,
  // else switch to the first other project that has one (its group sits at the top).
  const jumpToNeedsYou = () => {
    if (liveAwaiting.length > 0) { setSelTask(liveAwaiting[0].id); return; }
    const p = activeProjects.find((p) => p.id !== selProj && p.awaiting_count > 0);
    if (p) selectProject(p.id);
  };

  // Jump straight to a specific task in any project — the "need you" dropdown's
  // row action. Setting selProj fires the load-tasks effect with selectFirst=false
  // (useEffect on selProj), so it won't clobber the selTask we set here.
  const goToTask = (projectId: string, taskId: string) => {
    setView("workspace");
    setSelProj(projectId);
    setSelTask(taskId);
  };

  const clearSession = useCallback(async (taskId: string) => {
    const t = tasks.find((x) => x.id === taskId);
    if (!t || running.has(taskId) || !t.started) return;
    setTaskRunning(taskId, true);
    try {
      const { summary } = await jsend<{ summary: string }>(`/api/tasks/${taskId}/clear`, "POST");
      appendMsg(taskId, { id: `sb-${Date.now()}`, role: "session_break", content: summary, generation: t.generation });
      const fresh = await jget<TaskRow>(`/api/tasks/${taskId}`);
      setTasks((prev) => prev.map((x) => (x.id === taskId ? { ...x, ...fresh } : x)));
    } finally {
      setTaskRunning(taskId, false);
    }
    // spin up the fresh window (re-prime with title + description + carried summary)
    runTurn(taskId, "", true);
  }, [tasks, running, runTurn, appendMsg]);

  const setStatus = async (s: Status) => {
    if (!task) return;
    const fresh = await jsend<TaskRow>(`/api/tasks/${task.id}`, "PATCH", { status: s });
    setTasks((prev) => prev.map((x) => (x.id === task.id ? { ...x, ...fresh } : x)));
  };
  const setPriority = async (p: Priority) => {
    if (!task) return;
    const fresh = await jsend<TaskRow>(`/api/tasks/${task.id}`, "PATCH", { priority: p });
    setTasks((prev) => prev.map((x) => (x.id === task.id ? { ...x, ...fresh } : x)));
  };
  const setModel = async (m: string | null) => {
    if (!task) return;
    const fresh = await jsend<TaskRow>(`/api/tasks/${task.id}`, "PATCH", { model: m });
    setTasks((prev) => prev.map((x) => (x.id === task.id ? { ...x, ...fresh } : x)));
  };
  const setReasoning = async (r: string | null) => {
    if (!task) return;
    const fresh = await jsend<TaskRow>(`/api/tasks/${task.id}`, "PATCH", { reasoning: r });
    setTasks((prev) => prev.map((x) => (x.id === task.id ? { ...x, ...fresh } : x)));
  };
  const setPermission = async (p: string | null) => {
    if (!task) return;
    const fresh = await jsend<TaskRow>(`/api/tasks/${task.id}`, "PATCH", { permission_mode: p });
    setTasks((prev) => prev.map((x) => (x.id === task.id ? { ...x, ...fresh } : x)));
  };

  const createTask = async (input: { title: string; desc: string; priority: Priority; agent: string; startNow: boolean; depends_on: string[] }) => {
    if (!project) return;
    const t = await jsend<TaskRow>("/api/tasks", "POST", { project_id: project.id, title: input.title, description: input.desc, priority: input.priority, agent: input.agent });
    // Dependencies are an edit-after-create step (the task id doesn't exist until now).
    if (input.depends_on.length) await jsend(`/api/tasks/${t.id}`, "PATCH", { depends_on: input.depends_on });
    await loadTasks(project.id, false);
    setSelTask(t.id);
    setModal(null);
    if (input.startNow) runTurn(t.id, "", true);
  };

  const saveTask = async (id: string, patch: { title: string; description: string; priority: Priority; depends_on: string[] }) => {
    const fresh = await jsend<TaskRow>(`/api/tasks/${id}`, "PATCH", patch);
    setTasks((prev) => prev.map((x) => (x.id === id ? { ...x, ...fresh } : x)));
    setEditId(null);
  };

  // Hard-deletes the task (and its worktree/branch server-side), closes the edit
  // modal, and drops it from the selection if it was the one being viewed.
  const removeTask = async (id: string) => {
    await jsend(`/api/tasks/${id}`, "DELETE");
    setTasks((prev) => prev.filter((x) => x.id !== id));
    setEditId(null);
    setSelTask((cur) => (cur === id ? null : cur));
  };

  const startSuggestion = async (id: string) => {
    await jsend<TaskRow>(`/api/tasks/${id}`, "PATCH", { suggested: 0 });
    if (selProj) await loadTasks(selProj, false);
    setSelTask(id);
    runTurn(id, "", true);
  };
  const acceptSuggestion = async (id: string) => {
    await jsend<TaskRow>(`/api/tasks/${id}`, "PATCH", { suggested: 0 });
    if (selProj) await loadTasks(selProj, false);
  };
  const dismissSuggestion = async (id: string) => {
    await jsend(`/api/tasks/${id}`, "DELETE");
    if (selProj) await loadTasks(selProj, false);
  };

  const saveContext = async (patch: { name: string; context: string; repo_path: string; branch: string; dev_command: string; setup_command: string; test_command: string }) => {
    if (!project) return;
    await jsend(`/api/projects/${project.id}`, "PATCH", patch);
    const ps = await jget<ProjectRow[]>("/api/projects");
    setProjects(ps);
    setModal(null);
  };
  const createProject = async (input: { name: string; sub: string; color: string; context: string; repo_path: string; branch?: string }) => {
    const p = await jsend<ProjectRow>("/api/projects", "POST", input);
    const ps = await jget<ProjectRow[]>("/api/projects");
    setProjects(ps);
    setSelProj(p.id);
    setSelTask(null);
    setModal(null);
  };
  const reorderProjects = useCallback((ids: string[]) => {
    // Optimistically reorder, then persist. On failure, reload from server.
    // `ids` covers only the active list; deprecated projects keep their order.
    setProjects((prev) => {
      const byId = new Map(prev.map((p) => [p.id, p]));
      const reordered = ids.map((id) => byId.get(id)).filter((p): p is ProjectRow => !!p);
      const untouched = prev.filter((p) => !ids.includes(p.id));
      return [...reordered, ...untouched];
    });
    jsend("/api/projects/reorder", "POST", { ids }).catch(() => {
      jget<ProjectRow[]>("/api/projects").then(setProjects);
    });
  }, []);
  const removeProject = async (id: string) => {
    await jsend(`/api/projects/${id}`, "DELETE");
    const ps = await jget<ProjectRow[]>("/api/projects");
    setProjects(ps);
    setModal(null);
    if (selProj === id) { setSelProj(ps.find((p) => !p.deprecated)?.id ?? null); setSelTask(null); }
  };
  const setDeprecated = async (id: string, deprecated: boolean) => {
    await jsend(`/api/projects/${id}`, "PATCH", { deprecated: deprecated ? 1 : 0 });
    const ps = await jget<ProjectRow[]>("/api/projects");
    setProjects(ps);
    setModal(null);
    // Leaving a project that just got hidden: fall back to the first active one.
    if (deprecated && selProj === id) { setSelProj(ps.find((p) => !p.deprecated)?.id ?? null); setSelTask(null); }
    // Restoring: jump straight into the project so you can build on it again.
    if (!deprecated) { setSelProj(id); setSelTask(null); }
  };

  // Restore run defaults to built-ins: clear every server-backed default_* key
  // (agent-scoped and legacy) plus the reset of client-only settings.
  const resetSettings = () => {
    setSettings(DEFAULT_SETTINGS);
    for (const key of Object.keys(appDefaults)) if (key.startsWith("default_") || key === "utility_agent") void setAppDefault(key, null);
  };

  // Set a project's default agent for new tasks (persisted; existing tasks keep
  // the agent they were created with).
  const setProjectDefaultAgent = async (agent: string) => {
    if (!project) return;
    await jsend(`/api/projects/${project.id}`, "PATCH", { default_agent: agent });
    setProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, default_agent: agent } : p)));
  };

  return {
    // state + derived
    booted, bootError, retryBoot: boot, tasksLoading, transcriptLoading,
    projects, activeProjects, deprecatedProjects, selProj, setSelProj, project,
    tasks, realTasks, suggested, selTask, task, messages, running,
    blockedBy, liveAwaiting, needsYouTotal,
    modal, setModal, editId, setEditId, view, setView,
    appearance, setAppearance, appearanceOpen, setAppearanceOpen,
    settings, setSetting, appDefaults, setAppDefault, agents,
    onboarding, wizardOpen, finishWizard, rerunOnboarding, nudge, setNudge, onMerged, onPrCreated,
    layout, setLayout, accessEmail, recaps,
    termOpen, setTermOpen, termMounted, setTermMounted, termHeight, setTermHeight,
    servicesOpen, setServicesOpen, servicesMounted, setServicesMounted, servicesHeight, setServicesHeight,
    // actions
    setSelTask, fetchRecap, runTurn, answerQuestion, stopTurn, cancelQueued, resolveConflictsWithAI,
    selectProject, jumpToNeedsYou, goToTask, clearSession, setStatus, setPriority, setModel,
    setReasoning, setPermission, createTask, saveTask, removeTask, startSuggestion, acceptSuggestion,
    dismissSuggestion, saveContext, createProject, reorderProjects, removeProject, setDeprecated,
    resetSettings, setProjectDefaultAgent,
  };
}
