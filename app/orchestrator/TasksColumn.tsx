"use client";

import { useEffect, useState } from "react";
import { Icon } from "../icons";
import { isAwaiting, relTime } from "./format";
import { SLABEL, AWAIT_LABEL, SEARCH_MIN, type ProjectRow, type TaskRow, type AgentsBundle } from "./types";
import { agentLabel } from "./agents";
import { StatusDot, PriPill, SearchBar, AgentBadge } from "./shared";
import { TaskCardSkeleton } from "./Layout";

function TaskCard({ task, agents, selected, running, blockedBy, onSelect }: { task: TaskRow; agents: AgentsBundle; selected: boolean; running: boolean; blockedBy?: string[]; onSelect: () => void }) {
  const sessionCount = task.started ? task.generation : Math.max(0, task.generation - 1);
  const awaiting = isAwaiting(task);
  const blocked = !!blockedBy?.length && !task.started;
  // Awaiting wins over running: a turn parked on a question is live but really
  // waiting on you, so it should read "waiting", not "working".
  const activity = awaiting ? `waiting on you · ${relTime(task.updated_at)}`
    : running ? "live · working"
    : task.status === "done" ? `done · ${relTime(task.updated_at)}`
    : task.status === "cancelled" ? `cancelled · ${relTime(task.updated_at)}`
    : task.started ? relTime(task.updated_at) : "not started";
  return (
    <button className={`task ${selected ? "sel" : ""} ${awaiting ? "awaiting" : ""}`} onClick={onSelect}>
      <div className="task-top">
        <StatusDot status={task.status} running={running} awaiting={awaiting} />
        <span className="ttitle">{task.title}</span>
        <span className={`slabel ${awaiting ? "await" : ""}`}>{awaiting ? AWAIT_LABEL : SLABEL[task.status]}</span>
        <AgentBadge label={agentLabel(agents, task.agent)} multi={agents.agents.length > 1} />
        <PriPill p={task.priority} />
      </div>
      {blocked && (
        <div className="blocked-chip" title={`Blocked until done: ${blockedBy!.join(", ")}`}>
          {Icon.lock()} Blocked by {blockedBy!.length === 1 ? blockedBy![0] : `${blockedBy!.length} tasks`}
        </div>
      )}
      {task.description && <div className="tdesc">{task.description}</div>}
      <div className="task-foot">
        <span className="activity">{awaiting ? <span style={{ color: "var(--blue)" }}>●</span> : running ? <span style={{ color: "var(--amber)" }}>●</span> : null}{activity}</span>
        <span className="spacer" />
        {sessionCount > 0 && <span className="activity">{sessionCount} session{sessionCount !== 1 ? "s" : ""}</span>}
      </div>
    </button>
  );
}

function TaskGroup({ label, tasks, agents, selTaskId, running, blockedBy, onSelect, accent, collapsible, collapsed, onToggle }: { label: string; tasks: TaskRow[]; agents: AgentsBundle; selTaskId: string | null; running: Set<string>; blockedBy: Map<string, string[]>; onSelect: (id: string) => void; accent?: boolean; collapsible?: boolean; collapsed?: boolean; onToggle?: () => void }) {
  if (tasks.length === 0) return null;
  if (collapsible) {
    return (
      <>
        <button className={`task-group-h tgh-btn ${collapsed ? "is-collapsed" : ""}`} onClick={onToggle} title={`${collapsed ? "Show" : "Hide"} ${label.toLowerCase()} tasks`}>
          {Icon.chevDown({ className: "tgh-chev" })}
          {label} <span className="gcount">{tasks.length}</span><span className="gline" />
        </button>
        {!collapsed && tasks.map((t) => <TaskCard key={t.id} task={t} agents={agents} selected={t.id === selTaskId} running={running.has(t.id)} blockedBy={blockedBy.get(t.id)} onSelect={() => onSelect(t.id)} />)}
      </>
    );
  }
  return (
    <>
      <div className={`task-group-h ${accent ? "needs-you" : ""}`}>{label} <span className="gcount">{tasks.length}</span><span className="gline" /></div>
      {tasks.map((t) => <TaskCard key={t.id} task={t} agents={agents} selected={t.id === selTaskId} running={running.has(t.id)} blockedBy={blockedBy.get(t.id)} onSelect={() => onSelect(t.id)} />)}
    </>
  );
}

// Per-group collapsed flag, persisted in localStorage under `key`.
function useCollapsed(key: string, def: boolean) {
  const [collapsed, setCollapsed] = useState(def);
  useEffect(() => {
    try {
      const v = localStorage.getItem(key);
      setCollapsed(v === null ? def : v === "1");
    } catch {}
  }, [key, def]);
  const toggle = () => setCollapsed((c) => {
    const next = !c;
    try { localStorage.setItem(key, next ? "1" : "0"); } catch {}
    return next;
  });
  return [collapsed, toggle] as const;
}

export function TasksColumn({ project, agents, tasks, suggested, selTaskId, running, blockedBy, width, loading, onSelectTask, onNewTask, onEditContext, onShowSessions, onShowRecap, onEditTask, onStartSuggestion, onAcceptSuggestion, onDismissSuggestion, onCollapse, mobile, onBack }: {
  project: ProjectRow; agents: AgentsBundle; tasks: TaskRow[]; suggested: TaskRow[]; selTaskId: string | null; running: Set<string>; blockedBy: Map<string, string[]>; width: number; loading?: boolean;
  onSelectTask: (id: string) => void; onNewTask: () => void; onEditContext: () => void; onShowSessions: () => void; onShowRecap: () => void;
  onEditTask: (id: string) => void; onCollapse: () => void;
  onStartSuggestion: (id: string) => void; onAcceptSuggestion: (id: string) => void; onDismissSuggestion: (id: string) => void;
  mobile?: boolean; onBack?: () => void;
}) {
  const [query, setQuery] = useState("");
  // Minimize the Done/Cancelled groups so a long backlog of finished (or
  // abandoned) tasks doesn't force scrolling past them. Per-project, persisted
  // so the choice sticks across reloads. Cancelled starts collapsed — it's the
  // graveyard, not the working set.
  const [doneCollapsed, toggleDone] = useCollapsed(`orch_done_collapsed_${project.id}`, false);
  const [cancelledCollapsed, toggleCancelled] = useCollapsed(`orch_cancelled_collapsed_${project.id}`, true);
  const q = query.trim().toLowerCase();
  const match = (t: TaskRow) => !q || t.title.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q);
  const shown = tasks.filter(match);
  const shownSuggested = suggested.filter(match);
  const needsYou = shown.filter((t) => isAwaiting(t));
  const groups = {
    a: shown.filter((t) => t.status === "in_progress" && !isAwaiting(t)),
    h: shown.filter((t) => t.status === "on_hold" && !isAwaiting(t)),
    r: shown.filter((t) => t.status === "not_started"),
    g: shown.filter((t) => t.status === "done").sort((a, b) => b.updated_at - a.updated_at),
    x: shown.filter((t) => t.status === "cancelled").sort((a, b) => b.updated_at - a.updated_at),
  };
  const canSearch = tasks.length + suggested.length >= SEARCH_MIN;
  const noMatches = q && shown.length === 0 && shownSuggested.length === 0;
  return (
    <div className="col col-tasks" style={{ flexBasis: width }}>
      <div className="proj-banner">
        <div className="pb-row">
          {onBack && <button className="mobile-back" onClick={onBack} title="Back to projects" aria-label="Back to projects">{Icon.chevRight({ style: { transform: "rotate(180deg)" } })}</button>}
          <button className="pb-home" onClick={onShowRecap} title="Project recap / overview">
            <span className="pb-pic" style={{ background: project.color }}>{project.name[0]}</span>
            <span className="pb-name">{project.name}</span>
          </button>
          <button className="btn btn-line btn-sm" onClick={onShowSessions} title="Agent sessions run under this project">{Icon.clock()} Sessions</button>
          <button className="btn btn-line btn-sm" onClick={onNewTask}>{Icon.plus()} Task</button>
          {!mobile && <button className="icon-btn" onClick={onCollapse} title="Hide tasks panel">{Icon.chevRight({ style: { transform: "rotate(180deg)" } })}</button>}
        </div>
        <button className="pb-ctx" onClick={onEditContext} title="Edit project context">
          <div className={`ctx-txt ${project.context ? "" : "empty-ctx"}`}>
            {project.context || "Add project context — description, stack & conventions, prepended to every task."}
          </div>
          <div className="ctx-edit">{Icon.edit()} Context</div>
        </button>
      </div>
      {canSearch && <SearchBar value={query} onChange={setQuery} placeholder="Search tasks…" />}
      {loading ? (
        // The list in state is still the previous project's — skeleton cards
        // instead of a flash of the wrong tasks (or a false "No tasks yet").
        <div className="scroll">
          <div className="task-scroll">
            {[0, 1, 2].map((i) => <TaskCardSkeleton key={i} i={i} />)}
          </div>
        </div>
      ) : (
      <div className="scroll">
        <div className="task-scroll">
          {tasks.length === 0 && <div className="empty" style={{ padding: "30px 16px" }}><div className="e-t">No tasks yet</div><div className="e-s">Create one to start an agent session.</div></div>}
          {noMatches && <div className="search-empty">No tasks match “{query.trim()}”.</div>}
          <TaskGroup label="Needs your input" tasks={needsYou} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} accent />
          <TaskGroup label="In progress" tasks={groups.a} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} />
          <TaskGroup label="On hold" tasks={groups.h} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} />
          <TaskGroup label="Not started" tasks={groups.r} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} />
          <TaskGroup label="Done" tasks={groups.g} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} collapsible collapsed={doneCollapsed && !q} onToggle={toggleDone} />
          <TaskGroup label="Cancelled" tasks={groups.x} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} collapsible collapsed={cancelledCollapsed && !q} onToggle={toggleCancelled} />
        </div>
        {shownSuggested.length > 0 && (
          <div className="suggest">
            <div className="suggest-h">{Icon.spark()} Suggested by agents<span className="sp">{shownSuggested.length}</span></div>
            {shownSuggested.map((s) => (
              <div key={s.id} className="sug">
                <StatusDot status="not_started" />
                <div className="sg-meta">
                  <div className="sg-name">{s.title}</div>
                  {s.description && <div className="sg-why">{s.description}</div>}
                </div>
                <button className="sug-dismiss" title="Edit title & description" onClick={() => onEditTask(s.id)}>{Icon.edit()}</button>
                <button className="sug-add" title="Add to task list to start later" onClick={() => onAcceptSuggestion(s.id)}>{Icon.plus()} Add</button>
                <button className="sug-btn" onClick={() => onStartSuggestion(s.id)}>{Icon.play()} Start</button>
                <button className="sug-dismiss" title="Dismiss" onClick={() => onDismissSuggestion(s.id)}>{Icon.x()}</button>
              </div>
            ))}
          </div>
        )}
      </div>
      )}
    </div>
  );
}
