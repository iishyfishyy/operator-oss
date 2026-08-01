"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Status, Priority, ToolData, AskQuestion, AskAnswers } from "@/lib/types";
import { Icon } from "../icons";
import TaskChanges, { type ResolveResult } from "../TaskChanges";
import { fmtTokens, fmtCost, modelLabel, isAwaiting, buildSessions, usageSplit, costDisplay, usageTooltip } from "./format";
import {
  SLABEL, SSUB, AWAIT_LABEL, STATUSES, PLABEL, PRIORITIES,
  modelOptions, reasoningOptions, permissionOptions, RAIL_W,
  type ProjectRow, type TaskRow, type Msg, type SyncStatusResp, type AgentsBundle,
} from "./types";
import { capsFor, agentLabel, findAgent } from "./agents";
import { StatusDot, Avatar, Popover, AgentBadge, Skel } from "./shared";
import { MessageView, SessionBreak } from "./Transcript";
import { Composer } from "./Composer";
import { SessionRail } from "./SessionRail";
import { ColResize, ColRail } from "./Layout";

// Non-blocking banner shown when a reopened task's worktree is behind its base
// branch. Computed (read-only) on open; the actual git op fires only when the user
// clicks. Fast-forward-able tasks show nothing here — they catch up silently on the
// next message — so the banner only appears for tier 2 (clean merge → Sync) and
// tier 3 (conflicts → Fix with AI).
function SyncBanner({ taskId, running, onResolveWithAI, onSwitchToChat }: {
  taskId: string; running: boolean;
  onResolveWithAI: (taskId: string) => Promise<ResolveResult>;
  onSwitchToChat: () => void;
}) {
  const [st, setSt] = useState<SyncStatusResp | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { const r = await fetch(`/api/tasks/${taskId}/sync`, { cache: "no-store" }); setSt(await r.json()); }
    catch { setSt(null); }
  }, [taskId]);

  // Recompute on open and whenever a turn finishes (a turn may have fast-forwarded
  // or otherwise moved the branch). Skip while running to avoid mid-merge reads.
  useEffect(() => { if (!running) load(); }, [running, load]);

  if (!st || !st.isolated || !st.behind) return null;
  if (st.canFastForward) return null; // resolves silently on the next message

  const conflicts = st.conflicts?.length ?? 0;

  const doSync = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/tasks/${taskId}/sync`, { method: "POST" });
      const res = await r.json();
      // Prediction said clean but the real merge conflicted — escalate to Fix with AI.
      if (res?.conflicts?.length) { const fix = await onResolveWithAI(taskId); if (fix.ok && !fix.merged) onSwitchToChat(); }
    } finally { setBusy(false); load(); }
  };

  const doFix = async () => {
    setBusy(true);
    try { const res = await onResolveWithAI(taskId); if (res.ok && !res.merged) onSwitchToChat(); }
    finally { setBusy(false); load(); }
  };

  return (
    <div className={`sync-banner${conflicts ? " conflict" : ""}`}>
      <span className="sync-msg">
        {conflicts > 0
          ? `${st.behind} behind ${st.baseBranch} · conflicts in ${conflicts} file${conflicts === 1 ? "" : "s"}`
          : `${st.behind} commit${st.behind === 1 ? "" : "s"} behind ${st.baseBranch}`}
      </span>
      <span className="sync-spacer" />
      {conflicts > 0 ? (
        <button className="tc-btn primary" onClick={doFix} disabled={busy || running}>{busy ? "…" : "Fix with AI"}</button>
      ) : (
        <button className="tc-btn primary" onClick={doSync} disabled={busy || running}>{busy ? "Syncing…" : "Sync"}</button>
      )}
    </div>
  );
}

function TaskHero({ task, project, onStart, onEdit, running, blockedBy }: { task: TaskRow; project: ProjectRow; onStart: () => void; onEdit: () => void; running: boolean; blockedBy?: string[] }) {
  const carried = task.generation > 1;
  const blocked = !!blockedBy?.length && !task.started;
  const statusLine = carried ? "Fresh window · summary carried" : `${SLABEL[task.status]} · no session yet`;
  return (
    <div className="hero">
      <div className="h-ic">{Icon.bolt()}</div>
      <div className="h-status"><StatusDot status={task.status} /> {statusLine}</div>
      <h2>{task.title}</h2>
      {task.description && <p className="h-desc">{task.description}</p>}
      <div className="h-prompt">
        <div className="hp-h">Initial prompt the agent will receive</div>
        <div className="hp-b">
          <span className="ctx-pre">↳ {project.name} project context{carried ? " + previous session summary" : ""} (auto-prepended)</span>
          <strong>{task.title}.</strong> {task.description}
        </div>
      </div>
      {blocked && (
        <div className="hero-blocked" title={`Blocked until done: ${blockedBy!.join(", ")}`}>
          {Icon.lock()} Blocked until {blockedBy!.length === 1 ? <strong>{blockedBy![0]}</strong> : `${blockedBy!.length} tasks`} {blockedBy!.length === 1 ? "is" : "are"} done. Edit the task to change its dependencies.
        </div>
      )}
      <div style={{ display: "flex", gap: 10 }}>
        <button className="btn btn-accent" style={{ height: 38, padding: "0 20px", fontSize: 14 }} onClick={onStart} disabled={running || blocked} title={blocked ? `Blocked until done: ${blockedBy!.join(", ")}` : undefined}>
          {Icon.play()} {running ? "Starting…" : blocked ? "Blocked" : "Start session"}
        </button>
        <button className="btn btn-line" style={{ height: 38, padding: "0 16px", fontSize: 14 }} onClick={onEdit} disabled={running} title="Edit title & description before starting">
          {Icon.edit()} Edit
        </button>
      </div>
    </div>
  );
}

// Ref-backed identity-stable wrapper: Orchestrator passes fresh inline handlers
// on every render, which would defeat MessageView's memo — the wrapper keeps one
// function identity for the component's lifetime while always invoking the
// latest handler.
function useStableHandler<A extends unknown[]>(fn?: (...args: A) => void): (...args: A) => void {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => { ref.current?.(...args); }, []);
}

export function SessionView({ project, task, agents, messages, running, blockedBy, transcriptLoading, onSend, onStart, onStop, onClear, onEdit, onDelete, onReconnect, onSetStatus, onSetPriority, onSetModel, onSetReasoning, onSetPermission, onResolveWithAI, onMerged, onPrCreated, onAnswer, onCancelQueued, onBack, mobile, railW, onRailWidth, onRailReset, railCollapsed, onRailCollapse, onRailExpand }: {
  project: ProjectRow; task: TaskRow; agents: AgentsBundle; messages: Msg[]; running: boolean; blockedBy?: string[]; transcriptLoading?: boolean;
  onSend: (t: string) => void; onStart: () => void; onStop: () => void; onClear: () => void; onEdit: () => void;
  onDelete: (id: string) => void;
  // Deep-link to Settings → Agents, for the transcript's "your login died" recovery button.
  onReconnect?: () => void;
  onSetStatus: (s: Status) => void; onSetPriority: (p: Priority) => void; onSetModel: (m: string | null) => void;
  onSetReasoning: (r: string | null) => void; onSetPermission: (p: string | null) => void;
  onResolveWithAI: (taskId: string) => Promise<ResolveResult>;
  onMerged?: () => void;
  onPrCreated?: (url: string) => void;
  onAnswer: (askId: string, questions: AskQuestion[], answers: AskAnswers) => void;
  onCancelQueued: (pendingId: string) => void;
  onBack?: () => void; mobile?: boolean;
  railW: number; onRailWidth: (w: number) => void; onRailReset: () => void;
  railCollapsed: boolean; onRailCollapse: () => void; onRailExpand: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [priOpen, setPriOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [view, setView] = useState<"chat" | "changes">("chat");
  const sessions = useMemo(() => buildSessions(messages), [messages]);
  const hasSession = task.started === 1 || messages.length > 0;
  const awaiting = isAwaiting(task);
  const stableAnswer = useStableHandler(onAnswer);
  const stableCancelQueued = useStableHandler(onCancelQueued);
  const stableClear = useStableHandler(onClear);
  const stableReconnect = useStableHandler(onReconnect);
  // Run-control pickers + feature gates come from this task's agent capabilities,
  // never a hardcoded list — so the options always match the agent it runs under.
  const caps = capsFor(agents, task.agent);
  const models = modelOptions(caps);
  const reasoningOpts = reasoningOptions(caps);
  const permissionOpts = permissionOptions(caps);
  // Usage chip: tokens split into fresh work vs re-read cache (the raw total is
  // mostly cache reads and wildly overstates what ran), and a dollar figure whose
  // presentation follows how this agent is signed in — a subscription login's
  // figure is an API-price equivalent covered by plan quota, not a bill. Both
  // derivations live in ./format so the wording has one home.
  const usage = usageSplit(task);
  const cost = costDisplay(findAgent(agents, task.agent));
  const multiAgent = agents.agents.length > 1;
  // PR number for the header chip, parsed from the stored URL (…/pull/42).
  const prNum = task.pr_url?.match(/\/pull\/(\d+)/)?.[1];
  // True while a question card is still unanswered — hides the "thinking" dots,
  // since Claude is parked on the user, not working.
  const awaitingAnswer = useMemo(() => messages.some((m) => {
    if (m.role !== "tool") return false;
    try { const d = JSON.parse(m.content) as ToolData; return !!d.ask && !d.ask.answers; } catch { return false; }
  }), [messages]);

  // Auto-scroll only while the user is parked at the bottom. If they scroll up to
  // read earlier output, we leave their position alone even as new messages stream
  // in, and surface a "jump to bottom" button instead.
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    pinned.current = bottom;
    setAtBottom(bottom);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    pinned.current = true;
    setAtBottom(true);
  }, []);

  // Jump between the user's own messages in the transcript. dir < 0 goes to the
  // previous one above the current scroll position, dir > 0 to the next below it;
  // queued (not-yet-sent) bubbles are excluded so nav only lands on real turns.
  const scrollToUserMsg = useCallback((dir: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    const base = el.getBoundingClientRect().top;
    const tops = Array.from(el.querySelectorAll<HTMLElement>(".msg.user:not(.queued)"))
      .map((n) => n.getBoundingClientRect().top - base + el.scrollTop);
    if (!tops.length) return;
    const cur = el.scrollTop;
    const eps = 8;
    let target: number;
    if (dir < 0) {
      const prev = tops.filter((t) => t < cur - eps);
      target = prev.length ? prev[prev.length - 1] : tops[0];
    } else {
      const next = tops.filter((t) => t > cur + eps);
      target = next.length ? next[0] : tops[tops.length - 1];
    }
    el.scrollTo({ top: Math.max(0, target - 12), behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (pinned.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, running]);

  // Switching tasks (or in/out of chat view) always jumps to the latest.
  useEffect(() => {
    pinned.current = true;
    setAtBottom(true);
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [task.id, view]);

  const chatPane = (
    <>
      <div className="transcript-wrap">
      <div className="transcript" ref={scrollRef} onScroll={onScroll}>
        <div className="tw">
          {transcriptLoading && messages.length === 0 && (
            // Snapshot hasn't streamed in yet — sketch a user turn and an agent
            // reply so opening a started task never flashes an empty chat.
            <div aria-hidden>
              <div className="session-label"><span className="ln" />Loading session<span className="ln" /></div>
              <div className="msg user" style={{ opacity: .7 }}>
                <div className="who"><Skel w={18} h={18} r={5} /><Skel w={34} h={9} /></div>
                <div className="msg-body"><Skel w="72%" h={12} /><Skel w="46%" h={12} style={{ marginTop: 9 }} /></div>
              </div>
              <div className="msg" style={{ opacity: .7 }}>
                <div className="who"><Skel w={18} h={18} r={5} /><Skel w={70} h={9} /></div>
                <Skel w="90%" h={11} />
                <Skel w="83%" h={11} style={{ marginTop: 8 }} />
                <Skel w="58%" h={11} style={{ marginTop: 8 }} />
                <Skel w="100%" h={34} r="var(--r)" style={{ marginTop: 12 }} />
              </div>
            </div>
          )}
          {sessions.map((s, si) => (
            <div key={s.n}>
              {si > 0 && s.summaryBefore && <SessionBreak summary={s.summaryBefore} />}
              <div className="session-label"><span className="ln" />Session {s.n}{si === sessions.length - 1 ? " · current" : ""}<span className="ln" /></div>
              {s.messages.map((m, mi) => {
                const prev = s.messages[mi - 1];
                // collapse the repeated "Claude Code" header across an assistant run (text → tool → text)
                const hideWho = m.role === "assistant" && !!prev && (prev.role === "assistant" || prev.role === "tool");
                return <MessageView key={m.id} m={m} initial={mi === 0 && m.role === "user"} hideWho={hideWho} running={running} agent={task.agent} agentLabel={agentLabel(agents, task.agent)} onAnswer={stableAnswer} onCancelQueued={stableCancelQueued} onClear={stableClear} onReconnect={stableReconnect} />;
              })}
            </div>
          ))}
          {running && !awaitingAnswer && (
            <div className="msg assistant"><div className="who"><Avatar who="cc" agent={task.agent} /> Agent</div><div className="msg-body"><span className="typing"><i /><i /><i /></span></div></div>
          )}
          {/* Follow-ups queued mid-turn, pinned below the live turn — they
              send in order once it ends. */}
          {messages.filter((m) => m.role === "queued").map((m) => (
            <MessageView key={m.id} m={m} initial={false} hideWho={false} onAnswer={stableAnswer} onCancelQueued={stableCancelQueued} />
          ))}
        </div>
      </div>
      <div className="msg-nav">
        <button className="msg-nav-btn" onClick={() => scrollToUserMsg(-1)} title="Previous message" aria-label="Scroll to previous message">
          {Icon.chevUp()}
        </button>
        <button className="msg-nav-btn" onClick={() => scrollToUserMsg(1)} title="Next message" aria-label="Scroll to next message">
          {Icon.chevDown()}
        </button>
        {!atBottom && (
          <button className="msg-nav-btn" onClick={() => scrollToBottom()} title="Jump to latest" aria-label="Jump to latest">
            {Icon.toBottom()}
          </button>
        )}
      </div>
      </div>
      <Composer task={task} agentLabel={agentLabel(agents, task.agent)} disabled={task.started !== 1} running={running} onSend={onSend} onStop={onStop} onClear={onClear} />
    </>
  );

  return (
      <div className="session">
        <div className="sess-head">
          {onBack && <button className="mobile-back" onClick={onBack} title="Back to tasks" aria-label="Back to tasks">{Icon.chevRight({ style: { transform: "rotate(180deg)" } })}</button>}
          <div className="sh-main">
            <div className="crumb">
              <span className="pic" style={{ width: 16, height: 16, borderRadius: 5, background: project.color, display: "grid", placeItems: "center", color: "#fff", fontSize: 9, fontWeight: 700 }}>{project.name[0]}</span>
              {project.name} <span className="sep">/</span> task
            </div>
            <div className="sh-title">{task.title}</div>
          </div>
          <div className="sh-tools">
            {task.pr_url && (
              <a className="pr-chip" href={task.pr_url} target="_blank" rel="noreferrer" title={`Open this task's pull request — ${task.pr_url}`}>
                {Icon.github()} PR{prNum ? ` #${prNum}` : ""} {Icon.external()}
              </a>
            )}
            <AgentBadge label={agentLabel(agents, task.agent)} multi={multiAgent} />
            {(task.cost_usd > 0 || task.total_tokens > 0) && (
              <span className="usage-chip" title={usageTooltip(usage, task.cost_usd, cost)}>
                {fmtTokens(usage.fresh)} tok
                {usage.cacheRead > 0 && <> <span className="usage-dot">·</span> <span className="usage-cached">{fmtTokens(usage.cacheRead)} cached</span></>}
                {cost.show && <> <span className="usage-dot">·</span> {cost.approx && "~"}{fmtCost(task.cost_usd)}</>}
              </span>
            )}
            {mobile && hasSession && (
              <div className="viewseg">
                <button className={`viewseg-btn ${view === "chat" ? "on" : ""}`} onClick={() => setView("chat")}>Chat</button>
                <button className={`viewseg-btn ${view === "changes" ? "on" : ""}`} onClick={() => setView("changes")}>Changes</button>
              </div>
            )}
            <div style={{ position: "relative" }}>
              <button className="status-ctl" title={`Model this task's ${agentLabel(agents, task.agent)} session uses`} onClick={(e) => { e.stopPropagation(); setModelOpen((o) => !o); setStatusOpen(false); setPriOpen(false); setSettingsOpen(false); }}>
                {Icon.spark()}
                <span className="cv">{models.find((m) => m.value === task.model)?.label ?? "Default"}</span>
                {task.resolved_model && <span className="model-badge" title={`Last ran on ${task.resolved_model}`}>{modelLabel(task.resolved_model, caps)}</span>}
                {Icon.chevDown()}
              </button>
              {modelOpen && (
                <Popover onClose={() => setModelOpen(false)}>
                  {models.map((m, i) => (
                    <Fragment key={m.label}>
                      {/* Section header whenever the group changes — Claude Code's
                          list runs to a dozen-plus pins, so it needs the structure. */}
                      {m.group && m.group !== models[i - 1]?.group && <div className="pop-sec">{m.group}</div>}
                      <div className="pop-item" onClick={() => { onSetModel(m.value); setModelOpen(false); }}>
                        <div><div>{m.label}</div><div className="pi-sub">{m.sub}</div></div>
                        {(task.model ?? null) === m.value && <span className="pi-check">{Icon.check()}</span>}
                      </div>
                    </Fragment>
                  ))}
                </Popover>
              )}
            </div>
            <div style={{ position: "relative" }}>
              <button className="status-ctl" title="Reasoning level & permission mode for this task" onClick={(e) => { e.stopPropagation(); setSettingsOpen((o) => !o); setModelOpen(false); setStatusOpen(false); setPriOpen(false); }}>
                {Icon.gear()}
                <span className="cv">{reasoningOpts.find((r) => r.value === task.reasoning)?.label ?? "Default"}</span>
                {Icon.chevDown()}
              </button>
              {settingsOpen && (
                <Popover onClose={() => setSettingsOpen(false)}>
                  <div className="pop-sec">Reasoning</div>
                  {reasoningOpts.map((r) => (
                    <div key={r.label} className="pop-item" onClick={() => { onSetReasoning(r.value); setSettingsOpen(false); }}>
                      <div><div>{r.label}</div><div className="pi-sub">{r.sub}</div></div>
                      {(task.reasoning ?? null) === r.value && <span className="pi-check">{Icon.check()}</span>}
                    </div>
                  ))}
                  <div className="divider" />
                  <div className="pop-sec">Permission</div>
                  {permissionOpts.map((p) => (
                    <div key={p.label} className="pop-item" onClick={() => { onSetPermission(p.value); setSettingsOpen(false); }}>
                      <div><div>{p.label}</div><div className="pi-sub">{p.sub}</div></div>
                      {(task.permission_mode ?? null) === p.value && <span className="pi-check">{Icon.check()}</span>}
                    </div>
                  ))}
                </Popover>
              )}
            </div>
            <div style={{ position: "relative" }}>
              <button className="status-ctl" onClick={(e) => { e.stopPropagation(); setPriOpen((o) => !o); setStatusOpen(false); setModelOpen(false); setSettingsOpen(false); }}>
                {Icon.flag()} <span className="cv">{PLABEL[task.priority]}</span>
              </button>
              {priOpen && (
                <Popover onClose={() => setPriOpen(false)}>
                  {PRIORITIES.map((p) => (
                    <div key={p} className="pop-item" onClick={() => { onSetPriority(p); setPriOpen(false); }}>
                      <span className={`pri ${p}`}>{PLABEL[p].toUpperCase()}</span>
                      {task.priority === p && <span className="pi-check">{Icon.check()}</span>}
                    </div>
                  ))}
                </Popover>
              )}
            </div>
            <div style={{ position: "relative" }}>
              <button className={`status-ctl ${awaiting ? "awaiting" : ""}`} onClick={(e) => { e.stopPropagation(); setStatusOpen((o) => !o); setPriOpen(false); setModelOpen(false); setSettingsOpen(false); }}>
                <StatusDot status={task.status} running={running} awaiting={awaiting} />
                <span className="cv">{awaiting ? AWAIT_LABEL : SLABEL[task.status]}</span>
                {Icon.chevDown()}
              </button>
              {statusOpen && (
                <Popover onClose={() => setStatusOpen(false)}>
                  {STATUSES.map((s) => (
                    <div key={s} className="pop-item" onClick={() => { onSetStatus(s); setStatusOpen(false); }}>
                      <StatusDot status={s} />
                      <div><div>{SLABEL[s]}</div><div className="pi-sub">{SSUB[s]}</div></div>
                      {task.status === s && <span className="pi-check">{Icon.check()}</span>}
                    </div>
                  ))}
                </Popover>
              )}
            </div>
            {/* One-click completion — mirrors the status dropdown's 'done' choice
                but keeps the terminal state one visible tap away, so a
                dependency chain isn't stuck waiting on a state nobody knew to
                produce. Hidden once the task is already done. */}
            {task.status !== "done" && (
              <button
                className="btn btn-line btn-sm"
                title="Mark this task complete — releases any dependents waiting on it"
                onClick={() => onSetStatus("done")}
              >
                {Icon.check()} Mark complete
              </button>
            )}
            {hasSession && task.started === 1 && (
              <button className="btn btn-line btn-sm" title="Save summary & start a fresh context window" onClick={onClear} disabled={running}>{Icon.clear()} /clear</button>
            )}
            <div style={{ position: "relative" }}>
              <button
                className="status-ctl sh-more"
                title="More task actions"
                aria-label="More task actions"
                onClick={(e) => { e.stopPropagation(); setMoreOpen((o) => !o); setStatusOpen(false); setPriOpen(false); setModelOpen(false); setSettingsOpen(false); }}
              >
                {Icon.dots()}
              </button>
              {moreOpen && (
                <Popover onClose={() => setMoreOpen(false)}>
                  <div className="pop-item" onClick={() => { setMoreOpen(false); onDelete(task.id); }} style={{ color: "var(--red)" }}>
                    {Icon.x()} Delete task…
                  </div>
                </Popover>
              )}
            </div>
          </div>
        </div>

        {hasSession && (
          <SyncBanner taskId={task.id} running={running} onResolveWithAI={onResolveWithAI} onSwitchToChat={() => setView("chat")} />
        )}

        {!hasSession ? (
          <TaskHero task={task} project={project} onStart={onStart} onEdit={onEdit} running={running} blockedBy={blockedBy} />
        ) : !mobile ? (
          // Desktop: transcript beside the DIFF / PREVIEW / CONTEXT rail. The
          // zero-width seam between them holds the drag handle (a 0px grid track),
          // so the rail can be resized just like the projects/tasks columns.
          // Collapsed → the rail is swapped for a slim spine that restores it,
          // handing the full width to the transcript (mirrors the side columns).
          railCollapsed ? (
            <div className="sess-split" style={{ gridTemplateColumns: "minmax(0,1fr) 30px" }}>
              <div className="sess-main">{chatPane}</div>
              <ColRail label="Diff & Context" right onExpand={onRailExpand} />
            </div>
          ) : (
            <div className="sess-split" style={{ gridTemplateColumns: `minmax(0,1fr) 0px ${railW}px` }}>
              <div className="sess-main">{chatPane}</div>
              <ColResize
                side="right" min={RAIL_W.min} max={RAIL_W.max}
                onWidth={onRailWidth} onReset={onRailReset}
              />
              <SessionRail
                project={project} task={task} sessions={sessions} running={running}
                onResolveWithAI={onResolveWithAI} onMerged={onMerged} onPrCreated={onPrCreated}
                onMarkComplete={() => onSetStatus("done")}
                onClear={onClear} onCollapse={onRailCollapse} onSwitchToChat={() => { /* desktop transcript is always visible */ }}
              />
            </div>
          )
        ) : view === "changes" ? (
          <TaskChanges taskId={task.id} running={running} prUrl={task.pr_url} taskStatus={task.status} onMerged={onMerged} onPrCreated={onPrCreated} onMarkComplete={() => onSetStatus("done")} onResolveWithAI={async (id) => {
            const res = await onResolveWithAI(id);
            // Resolution turn was kicked off (conflicts, not a clean merge) —
            // jump back to Chat so the user sees the message stream in.
            if (res.ok && !res.merged) setView("chat");
            return res;
          }} />
        ) : (
          chatPane
        )}
      </div>
  );
}
