"use client";

import { useEffect, useState } from "react";
import { Icon } from "../icons";
import { isAwaiting, relTime } from "./format";
import { SLABEL, AWAIT_LABEL, SEARCH_MIN, type ProjectRow, type TaskRow, type AgentsBundle, type TaskView } from "./types";
import { agentLabel } from "./agents";
import { StatusDot, PriPill, SearchBar, AgentBadge } from "./shared";
import { TaskCardSkeleton } from "./Layout";
import { TaskBoard } from "./TaskBoard";
import { countNewSuggestions, groupSuggestions, isNewSuggestion } from "./suggestions";
import { SuggestionGroup, SuggestionRow, TrayHeader, UndoToast, outsideBlockerTitles, useTrayView, type ChainLaunch } from "./SuggestionGroup";
import type { PendingDismiss } from "./useOrchestrator";
import { ChainCard } from "./ChainReview";
import { chainsForReview } from "./chains";

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
      {blocked && (task.auto_start ? (
        // Queued to auto-start ≠ plain blocked: this one launches itself the
        // moment its last blocker is marked done.
        <div className="blocked-chip auto" title={`Starts automatically once done: ${blockedBy!.join(", ")}`}>
          {Icon.bolt()} Auto-starts after {blockedBy!.length === 1 ? blockedBy![0] : `${blockedBy!.length} tasks`}
        </div>
      ) : (
        <div className="blocked-chip" title={`Blocked until done: ${blockedBy!.join(", ")}`}>
          {Icon.lock()} Blocked by {blockedBy!.length === 1 ? blockedBy![0] : `${blockedBy!.length} tasks`}
        </div>
      ))}
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

export function TasksColumn({ project, agents, tasks, suggested, selTaskId, running, blockedBy, width, loading, view, onSetView, onMoveTask, onSelectTask, onNewTask, onEditContext, onShowSessions, onShowRecap, onEditTask, reviewChainId, onReviewChain, onContinueStep, onStartSuggestion, onAcceptSuggestion, onDismissSuggestions, onAcceptSuggestions, onLaunchChain, pendingDismiss, onUndoDismiss, onOpenParent, traySeenAt, traySeenReady, onTrayViewed, onCollapse, mobile, onBack }: {
  project: ProjectRow; agents: AgentsBundle; tasks: TaskRow[]; suggested: TaskRow[]; selTaskId: string | null; running: Set<string>; blockedBy: Map<string, string[]>; width: number; loading?: boolean;
  view: TaskView; onSetView: (v: TaskView) => void;
  onMoveTask: (id: string, patch: Partial<Pick<TaskRow, "status" | "suggested">>, orderedIds: string[]) => void;
  onSelectTask: (id: string) => void; onNewTask: () => void; onEditContext: () => void; onShowSessions: () => void; onShowRecap: () => void;
  onEditTask: (id: string) => void; onCollapse: () => void;
  // Auto-advance chains with a step In review get a card that opens the chain review.
  reviewChainId?: string | null; onReviewChain?: (chainId: string) => void;
  // "Continue" on a chain card's paused step: resume it so auto-advance can pick back up.
  onContinueStep?: (taskId: string) => void;
  onStartSuggestion: (id: string) => void; onAcceptSuggestion: (id: string) => void;
  onAcceptSuggestions: (ids: string[], start: boolean) => Promise<void>;
  // Every tray dismissal (one row, a group, or all stale groups) is undoable:
  // hidden now, deleted when the Undo window closes (see queueDismiss).
  onDismissSuggestions: (ids: string[], label: string) => void;
  pendingDismiss: PendingDismiss | null; onUndoDismiss: () => void;
  onLaunchChain: (launch: ChainLaunch) => Promise<void>;
  // Jump to the task a suggestion group came from (its header).
  onOpenParent: (id: string) => void;
  // The project's "last looked at the tray" mark (see useTrayView), whether the
  // prefs holding it have hydrated yet, and the callback that advances it.
  traySeenAt: number | undefined; traySeenReady: boolean; onTrayViewed: (projectId: string) => void;
  mobile?: boolean; onBack?: () => void;
}) {
  const [query, setQuery] = useState("");
  // Minimize the Done/Cancelled groups so a long backlog of finished (or
  // abandoned) tasks doesn't force scrolling past them. Per-project, persisted
  // so the choice sticks across reloads. Cancelled starts collapsed — it's the
  // graveyard, not the working set.
  const [doneCollapsed, toggleDone] = useCollapsed(`orch_done_collapsed_${project.id}`, false);
  const [cancelledCollapsed, toggleCancelled] = useCollapsed(`orch_cancelled_collapsed_${project.id}`, true);
  const [trayCollapsed, toggleTray] = useCollapsed(`orch_tray_collapsed_${project.id}`, false);
  const q = query.trim().toLowerCase();
  const match = (t: TaskRow) => !q || t.title.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q);
  const shown = tasks.filter(match);
  const shownSuggested = suggested.filter(match);
  const needsYou = shown.filter((t) => isAwaiting(t));
  const groups = {
    a: shown.filter((t) => t.status === "in_progress" && !isAwaiting(t)),
    h: shown.filter((t) => t.status === "on_hold" && !isAwaiting(t)),
    v: shown.filter((t) => t.status === "in_review"),
    r: shown.filter((t) => t.status === "not_started"),
    g: shown.filter((t) => t.status === "done").sort((a, b) => b.updated_at - a.updated_at),
    x: shown.filter((t) => t.status === "cancelled").sort((a, b) => b.updated_at - a.updated_at),
  };
  // The tray is grouped by the session that proposed each entry. Parent lookup
  // spans the project's WHOLE task list, not the search-filtered one — a group
  // header must still name its proposer when the proposer itself is filtered out.
  const allTasks = [...tasks, ...suggested];
  const sugGroups = groupSuggestions(shownSuggested, allTasks);
  const { newSince, trayRef } = useTrayView({ projectId: project.id, seenAt: traySeenAt, ready: traySeenReady, onViewed: onTrayViewed });
  const newCount = countNewSuggestions(shownSuggested, newSince);
  const canSearch = tasks.length + suggested.length >= SEARCH_MIN;
  const noMatches = q && shown.length === 0 && shownSuggested.length === 0;
  const toast = pendingDismiss?.projectId === project.id ? pendingDismiss : null;
  // Derived from the live task rows (kept current by /api/events) — no fetch.
  const reviewChains = onReviewChain ? chainsForReview(tasks, running) : [];
  // The tray sits ABOVE the task list: it's the inbox of proposed work, and a
  // folded tray costs one line. Searching always unfolds it so matches show.
  const trayOpen = !trayCollapsed || !!q;
  const tray = (shownSuggested.length > 0 || toast) && (
    <section className="sx-tray" ref={trayOpen ? trayRef : undefined}>
      <TrayHeader
        count={shownSuggested.length} newCount={newCount} groups={sugGroups}
        collapsed={!trayOpen} onToggle={toggleTray}
        onDismissStale={(ids) => onDismissSuggestions(ids, "from stale groups")}
      />
      {toast && <UndoToast pending={toast} onUndo={onUndoDismiss} />}
      {trayOpen && sugGroups.map((g) => (
        <SuggestionGroup
          key={g.key} group={g} variant="list" newSince={newSince} agents={agents} running={running}
          onOpenParent={onOpenParent} onDismiss={onDismissSuggestions} onAcceptAll={onAcceptSuggestions}
          onStartOne={onStartSuggestion} onAcceptOne={onAcceptSuggestion} onLaunchChain={onLaunchChain}
          renderItem={(s, position, groupTag) => (
            <SuggestionRow
              key={s.id} task={s} position={position} groupTag={groupTag}
              isNew={isNewSuggestion(s, newSince)} outsideBlockers={outsideBlockerTitles(s, g, blockedBy)}
              onEdit={() => onEditTask(s.id)} onDismiss={() => onDismissSuggestions([s.id], "")}
              onAccept={() => onAcceptSuggestion(s.id)} onStart={() => onStartSuggestion(s.id)}
            />
          )}
        />
      ))}
    </section>
  );
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
          <div className="view-toggle" role="tablist" aria-label="Task layout">
            <button className={view === "list" ? "on" : ""} role="tab" aria-selected={view === "list"} title="List view" onClick={() => onSetView("list")}>{Icon.list()}</button>
            <button className={view === "board" ? "on" : ""} role="tab" aria-selected={view === "board"} title="Board view" onClick={() => onSetView("board")}>{Icon.board()}</button>
          </div>
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
      ) : view === "board" ? (
        <div className="board-wrap">
          {noMatches && <div className="search-empty">No tasks match “{query.trim()}”.</div>}
          <TaskBoard
            project={project} tasks={shown} suggested={shownSuggested} allTasks={allTasks} agents={agents} selTaskId={selTaskId}
            running={running} blockedBy={blockedBy} canDrag={!q}
            onSelect={onSelectTask} onEditTask={onEditTask} onMove={onMoveTask}
            onStartSuggestion={onStartSuggestion} onAcceptSuggestion={onAcceptSuggestion}
            onAcceptSuggestions={onAcceptSuggestions} onDismissSuggestions={onDismissSuggestions} onLaunchChain={onLaunchChain}
            pendingDismiss={pendingDismiss?.projectId === project.id ? pendingDismiss : null} onUndoDismiss={onUndoDismiss} onOpenParent={onOpenParent}
            traySeenAt={traySeenAt} traySeenReady={traySeenReady} onTrayViewed={onTrayViewed}
          />
        </div>
      ) : (
      <div className="scroll">
        <div className="task-scroll">
          {tray}
          {tasks.length === 0 && <div className="empty" style={{ padding: "30px 16px" }}><div className="e-t">No tasks yet</div><div className="e-s">Create one to start an agent session.</div></div>}
          {noMatches && <div className="search-empty">No tasks match “{query.trim()}”.</div>}
          {reviewChains.length > 0 && (
            <>
              <div className="task-group-h">Chains to review <span className="gcount">{reviewChains.length}</span><span className="gline" /></div>
              {reviewChains.map((c) => (
                <ChainCard
                  key={c.id} chain={c} running={running} active={c.id === reviewChainId} onReview={() => onReviewChain!(c.id)}
                  onOpenStep={onSelectTask} onContinue={onContinueStep}
                />
              ))}
            </>
          )}
          <TaskGroup label="Needs your input" tasks={needsYou} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} accent />
          <TaskGroup label="In progress" tasks={groups.a} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} />
          <TaskGroup label="In review" tasks={groups.v} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} />
          <TaskGroup label="On hold" tasks={groups.h} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} />
          <TaskGroup label="Not started" tasks={groups.r} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} />
          <TaskGroup label="Done" tasks={groups.g} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} collapsible collapsed={doneCollapsed && !q} onToggle={toggleDone} />
          <TaskGroup label="Cancelled" tasks={groups.x} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} collapsible collapsed={cancelledCollapsed && !q} onToggle={toggleCancelled} />
        </div>
      </div>
      )}
    </div>
  );
}
