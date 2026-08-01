"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { TaskStreamEvent, ToolData, AskAnswers } from "@/lib/types";
import { jget, jsend } from "./api";
import { contextPct } from "./format";
import { capsFor } from "./agents";
import type { AgentsBundle, Msg, ProjectRow, TaskRow } from "./types";

// Owns the per-task transcript state (msgsByTask) plus the live SSE consumption:
// the snapshot-then-tail EventSource and the message mutators that apply each
// server event. The turn itself runs server-side, detached from any connection.
export function useTaskStream({ selTask, selProjRef, agentsRef, setTaskRunning, setTasks, setProjects, loadTasks }: {
  selTask: string | null;
  selProjRef: MutableRefObject<string | null>;
  agentsRef: MutableRefObject<AgentsBundle>;
  setTaskRunning: (id: string, on: boolean) => void;
  setTasks: React.Dispatch<React.SetStateAction<TaskRow[]>>;
  setProjects: React.Dispatch<React.SetStateAction<ProjectRow[]>>;
  loadTasks: (projectId: string, selectFirst?: boolean) => Promise<void>;
}) {
  const [msgsByTask, setMsgsByTask] = useState<Record<string, Msg[]>>({});
  // The per-task-selection "viewed" scheduler installs this each effect run;
  // handleStreamEvent below calls it whenever agent activity lands so the 2s
  // visible-and-quiet timer restarts (see the useEffect that owns the timer).
  const onViewTriggerRef = useRef<() => void>(() => {});

  // Asks still awaiting an answer, per task. One assistant message can park
  // several AskUserQuestion cards at once, and the "Needs your input" flag must
  // stay up until the last one is answered — mirrors openAsks in lib/runner.ts.
  const openAsksRef = useRef<Record<string, Set<string>>>({});

  const appendMsg = (taskId: string, m: Msg) =>
    setMsgsByTask((prev) => ({ ...prev, [taskId]: [...(prev[taskId] ?? []), m] }));

  // Mark an AskUserQuestion message (matched by tool id) as answered. Matches on
  // the id embedded in the content too, so it works for reloaded messages whose
  // in-memory toolId was lost.
  const setAnswerOnMsg = (taskId: string, askId: string, answers: AskAnswers) =>
    setMsgsByTask((prev) => {
      const arr = prev[taskId] ?? [];
      return {
        ...prev,
        [taskId]: arr.map((m) => {
          if (m.role !== "tool") return m;
          try {
            const d = JSON.parse(m.content) as ToolData;
            if (m.toolId !== askId && d.ask?.id !== askId) return m;
            d.ask = { id: d.ask?.id ?? askId, questions: d.ask?.questions ?? [], answers };
            return { ...m, content: JSON.stringify(d) };
          } catch {
            return m;
          }
        }),
      };
    });

  // Insert-or-replace a message by id. Live events carry their DB message id,
  // so replays after a reconnect (snapshot + tail overlap) stay idempotent.
  const upsertMsg = (taskId: string, m: Msg) =>
    setMsgsByTask((prev) => {
      const arr = prev[taskId] ?? [];
      return arr.some((x) => x.id === m.id)
        ? { ...prev, [taskId]: arr.map((x) => (x.id === m.id ? { ...x, ...m } : x)) }
        : { ...prev, [taskId]: [...arr, m] };
    });

  // Drop a message by id — used when a queued follow-up is dequeued (about to
  // run, or cancelled). If it's about to run, the matching `user` event re-adds
  // it as a committed message.
  const removeMsg = (taskId: string, msgId: string) =>
    setMsgsByTask((prev) => ({ ...prev, [taskId]: (prev[taskId] ?? []).filter((m) => m.id !== msgId) }));

  // Apply one server event to local state. Used by the per-task EventSource
  // below; the turn itself runs server-side, detached from any connection.
  const handleStreamEvent = (taskId: string, ev: TaskStreamEvent) => {
    // Snapshot arrival = the transcript is on screen; assistant/tool/turn_end =
    // new agent activity while it's on screen. Both are "the user just saw
    // something they might not have seen before" → arm the 2s-visible view
    // stamp so the badge clears once they've had time to actually read it.
    if (ev.type === "snapshot" || ev.type === "assistant" || ev.type === "tool" || ev.type === "turn_end") {
      onViewTriggerRef.current();
    }
    if (ev.type === "snapshot") {
      // Authoritative catch-up: the full persisted transcript, then any parked
      // follow-ups as "queued" bubbles (so a reload mid-run re-renders them),
      // plus whether a turn is live right now (true after a reload mid-turn).
      const committed: Msg[] = ev.messages.map((m) => ({ id: m.id, role: m.role, content: m.content, generation: m.generation }));
      const queued: Msg[] = ev.pending.map((p) => ({ id: p.id, role: "queued" as const, content: p.content, generation: p.generation }));
      setMsgsByTask((prev) => ({ ...prev, [taskId]: [...committed, ...queued] }));
      // Rebuild the open-ask set from the persisted transcript so a reload
      // mid-turn (with asks still parked) counts them correctly.
      const open = new Set<string>();
      for (const m of committed) {
        if (m.role !== "tool") continue;
        try {
          const d = JSON.parse(m.content) as ToolData;
          if (d.ask && !d.ask.answers) open.add(d.ask.id);
        } catch {}
      }
      openAsksRef.current[taskId] = open;
      setTaskRunning(taskId, ev.running);
      return;
    }
    const gen = ("generation" in ev ? ev.generation : undefined) ?? 1;
    if (ev.type === "user") upsertMsg(taskId, { id: ev.msgId, role: "user", content: ev.content, generation: gen });
    else if (ev.type === "queued") upsertMsg(taskId, { id: ev.msgId, role: "queued", content: ev.content, generation: gen });
    else if (ev.type === "dequeued") removeMsg(taskId, ev.msgId);
    else if (ev.type === "model") setTasks((prev) => prev.map((x) => (x.id === taskId ? { ...x, resolved_model: ev.model } : x)));
    else if (ev.type === "assistant") upsertMsg(taskId, { id: ev.msgId ?? `a-${Date.now()}-${Math.random()}`, role: "assistant", content: ev.content, generation: gen });
    else if (ev.type === "tool") {
      const data: ToolData = { title: ev.title, detail: ev.detail, peek: ev.peek, diff: ev.diff };
      upsertMsg(taskId, { id: ev.msgId ?? `t-${Date.now()}-${Math.random()}`, role: "tool", content: JSON.stringify(data), generation: gen, toolId: ev.id });
    } else if (ev.type === "tool_result") {
      // Match by DB message id (works on snapshot-loaded messages too), falling
      // back to the in-memory tool_use id.
      setMsgsByTask((prev) => {
        const arr = prev[taskId] ?? [];
        return {
          ...prev,
          [taskId]: arr.map((m) => {
            if (m.role !== "tool" || (m.id !== ev.msgId && m.toolId !== ev.id)) return m;
            try { const d = JSON.parse(m.content) as ToolData; d.result = ev.content; d.isError = ev.isError; if (ev.peek) d.peek = ev.peek; return { ...m, content: JSON.stringify(d) }; } catch { return m; }
          }),
        };
      });
    } else if (ev.type === "ask") {
      const data: ToolData = { title: "Question for you", ask: { id: ev.id, questions: ev.questions } };
      upsertMsg(taskId, { id: ev.msgId ?? `ask-${ev.id}`, role: "tool", content: JSON.stringify(data), generation: gen, toolId: ev.id });
      (openAsksRef.current[taskId] ??= new Set()).add(ev.id);
      // Parked on a question: flag the row so it jumps to "Needs your input"
      // (and triggers a notification) while the turn is still live. Mirrors the
      // server's updateTask in lib/runner.ts.
      setTasks((prev) => prev.map((x) => (x.id === taskId ? { ...x, awaiting_input: 1 } : x)));
    } else if (ev.type === "ask_answered") {
      setAnswerOnMsg(taskId, ev.id, ev.answers);
      // Only drop the flag once every parked ask on this task is answered.
      const open = openAsksRef.current[taskId];
      open?.delete(ev.id);
      if (!open || open.size === 0) {
        setTasks((prev) => prev.map((x) => (x.id === taskId ? { ...x, awaiting_input: 0 } : x)));
      }
    } else if (ev.type === "usage") {
      // Live cumulative spend: add this turn's totals to the task's figure.
      // Context occupancy, by contrast, is the latest turn's INPUT-side
      // tokens (not a sum) — it tracks how full the window is right now.
      const u = ev.usage;
      const turnTokens = u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_creation_tokens;
      const ctxTokens = u.input_tokens + u.cache_read_tokens + u.cache_creation_tokens;
      setTasks((prev) => prev.map((x) => (x.id === taskId
        ? { ...x, cost_usd: (x.cost_usd ?? 0) + u.cost_usd, total_tokens: (x.total_tokens ?? 0) + turnTokens,
            // Cache buckets accumulate alongside the total so the usage chip's
            // fresh-vs-cached split stays right mid-turn, not just after a reload.
            cache_read_tokens: (x.cache_read_tokens ?? 0) + u.cache_read_tokens,
            cache_creation_tokens: (x.cache_creation_tokens ?? 0) + u.cache_creation_tokens,
            context_tokens: ctxTokens, context_pct: contextPct(ctxTokens, x.model, capsFor(agentsRef.current, x.agent)) }
        : x)));
    } else if (ev.type === "notice") upsertMsg(taskId, { id: ev.msgId ?? `n-${Date.now()}`, role: "system", content: ev.content, generation: gen });
    else if (ev.type === "error") upsertMsg(taskId, { id: ev.msgId ?? `e-${Date.now()}`, role: "system", content: ev.content, generation: gen });
    else if (ev.type === "suggested") { if (selProjRef.current) loadTasks(selProjRef.current, false); }
    else if (ev.type === "turn_end") {
      setTaskRunning(taskId, false);
      // Any still-parked asks died with the turn (Stop rejects them server-side);
      // the refetch below restores the authoritative awaiting_input flag.
      delete openAsksRef.current[taskId];
      void (async () => {
        try { const fresh = await jget<TaskRow>(`/api/tasks/${taskId}`); setTasks((prev) => prev.map((x) => (x.id === taskId ? { ...x, ...fresh } : x))); } catch {}
        // Refresh the project list so the cross-project "Needs you" counts/badges update.
        try { setProjects(await jget<ProjectRow[]>("/api/projects")); } catch {}
      })();
    }
  };
  // The handler reads lots of component state; keep the EventSource effect's
  // dependency list down to the task id by routing through a ref.
  const handleStreamEventRef = useRef(handleStreamEvent);
  useEffect(() => { handleStreamEventRef.current = handleStreamEvent; });

  // One live stream per selected task: the server replays a snapshot of the
  // persisted transcript, then tails live turn events. Opening a task,
  // reloading mid-turn, and waking from laptop sleep all converge on the same
  // catch-up-then-tail path — EventSource reconnects re-snapshot automatically.
  useEffect(() => {
    if (!selTask) return;
    const id = selTask;

    // "Viewed" for the read-tracking badge — POST /api/tasks/[id]/view once
    // the user has actually had the transcript on screen. The stamp is what
    // the server-side derived awaiting predicate (lib/store.ts NEEDS_YOU)
    // compares agent activity against. Definition per Brief 3:
    //   snapshot delivered + tab visible + sustained ~2s.
    // Cancels on visibility drop or stream close so a tabbed-away moment or a
    // deep-link that never resolved doesn't count as reading. Rearmed by
    // subsequent agent activity so a fresh turn ending on screen also clears.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending = false; // an armed reason (snapshot / new activity) is waiting on a visible + quiet window
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const fireView = () => {
      pending = false;
      void jsend(`/api/tasks/${id}/view`, "POST").catch(() => {});
    };
    const schedule = () => {
      pending = true;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      clearTimer();
      timer = setTimeout(fireView, 2000);
    };
    const onVisibility = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState === "visible") { if (pending) schedule(); }
      else clearTimer(); // dropped visibility resets the sustained-2s window
    };
    onViewTriggerRef.current = schedule;

    const es = new EventSource(`/api/tasks/${id}/messages`);
    es.onmessage = (e) => {
      try { handleStreamEventRef.current(id, JSON.parse(e.data) as TaskStreamEvent); } catch {}
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

    return () => {
      es.close();
      clearTimer();
      onViewTriggerRef.current = () => {};
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [selTask]);

  return { msgsByTask, appendMsg, setAnswerOnMsg };
}
