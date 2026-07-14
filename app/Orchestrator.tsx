"use client";

import { useState, useEffect, useRef } from "react";
import { Icon } from "./icons";
import { TerminalView, type TermApi } from "./Terminal";
import { PROJ_W, TASK_W, DEFAULT_LAYOUT } from "./orchestrator/types";
import { useOrchestrator } from "./orchestrator/useOrchestrator";
import { ProjectsColumn } from "./orchestrator/ProjectsColumn";
import { TasksColumn } from "./orchestrator/TasksColumn";
import { SessionView } from "./orchestrator/SessionView";
import { ProjectLanding } from "./orchestrator/ProjectLanding";
import { SettingsView } from "./orchestrator/SettingsView";
import { InsightsView } from "./orchestrator/InsightsView";
import { TweaksPanel } from "./orchestrator/TweaksPanel";
import { ColResize, ColRail, TerminalDrawer, BootSkeleton } from "./orchestrator/Layout";
import { ServicesDrawer } from "./orchestrator/Services";
import { clientFeatures } from "@/lib/features";
import { NewTaskModal, EditTaskModal, ContextModal, NewProjectModal, SessionsModal } from "./orchestrator/modals";
import { OnboardingWizard } from "./orchestrator/OnboardingWizard";
import { AgentNudge } from "./orchestrator/AgentConnect";
import { WelcomeCoach, WelcomeNudge } from "./orchestrator/Welcome";
import { NeedsYouMenu } from "./orchestrator/NeedsYouMenu";
import { CommandPalette, type PaletteCommand } from "./orchestrator/CommandPalette";

// Below this width the three columns can't coexist, so the workspace collapses to
// one pane at a time (projects → tasks → session) with back affordances. matchMedia
// keeps it in sync with rotation/resize; SSR renders the desktop layout (false) and
// the effect corrects on mount — selection state alone drives which pane shows.
const MOBILE_QUERY = "(max-width: 760px)";
function useIsMobile() {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const sync = () => setMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return mobile;
}

// Phone terminal: a full-screen sheet (vs. the cramped desktop bottom-drawer) so
// output is actually legible. It's a read-mostly surface — glancing at a dev
// server, reading an error, pasting the Claude login code, tapping the OAuth URL
// — not a place to hand-type code, so input is just the few buttons people need.
function MobileTerminalSheet({ cwd, port, visible, onClose }: { cwd: string; port?: number; visible: boolean; onClose: () => void }) {
  const [epoch, setEpoch] = useState(0);   // bump → fresh shell
  const [fontSize, setFontSize] = useState(13);
  const apiRef = useRef<TermApi | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Pin the sheet to the *visual* viewport so the on-screen keyboard pushes the
  // button-bar and output up rather than covering them. visualViewport shrinks
  // when the keyboard opens; falling back to 100% when it's unavailable.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !visible) return;
    const apply = () => { if (sheetRef.current) sheetRef.current.style.height = `${vv.height}px`; };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => { vv.removeEventListener("resize", apply); vv.removeEventListener("scroll", apply); };
  }, [visible]);

  const send = (d: string) => apiRef.current?.send(d);
  const paste = async () => {
    try { const t = await navigator.clipboard.readText(); if (t) send(t); } catch { /* clipboard blocked — long-press paste still works */ }
  };

  return (
    <div ref={sheetRef} className={`mterm${visible ? "" : " hidden"}`}>
      <div className="mterm-bar">
        {Icon.terminal()}
        <span className="mterm-cwd">{cwd || "~ (no working dir)"}</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={() => setFontSize((f) => Math.max(9, f - 1))} title="Smaller text" aria-label="Smaller text">A−</button>
        <button className="icon-btn" onClick={() => setFontSize((f) => Math.min(22, f + 1))} title="Larger text" aria-label="Larger text">A+</button>
        <button className="icon-btn" onClick={() => setEpoch((e) => e + 1)} title="Restart shell">{Icon.clear()}</button>
        <button className="icon-btn" onClick={onClose} title="Close terminal (the shell keeps running)">{Icon.x()}</button>
      </div>
      <TerminalView key={epoch} cwd={cwd} port={port} fontSize={fontSize} onReady={(api) => { apiRef.current = api; }} />
      <div className="mterm-keys">
        <button className="mtk" onClick={paste}>Paste</button>
        <span style={{ flex: 1 }} />
        <button className="mtk" onClick={() => send("\x03")} title="Send Ctrl-C">Ctrl-C</button>
        <button className="mtk mtk-enter" onClick={() => send("\r")}>⏎ Enter</button>
      </div>
    </div>
  );
}

export default function Orchestrator() {
  const o = useOrchestrator();
  const { project, task, selProj, selTask, layout } = o;
  const isMobile = useIsMobile();
  const features = clientFeatures();
  const isDark = o.tweaks.theme !== "light";
  const [needsYouOpen, setNeedsYouOpen] = useState(false);
  // Which Settings section to land on when opened programmatically (e.g. the
  // "connect another agent" nudge deep-links to Agents). undefined = default.
  const [settingsSection, setSettingsSection] = useState<string | undefined>();
  const openSettings = (sect?: string) => { setSettingsSection(sect); o.setView("settings"); };
  // Drop the open flag if the pill itself disappears (count → 0), so it doesn't
  // silently re-open when a task next starts waiting.
  useEffect(() => { if (o.needsYouTotal === 0) setNeedsYouOpen(false); }, [o.needsYouTotal]);

  // ⌘K / Ctrl-K command palette. Same flag as the top-bar omni button, so
  // re-enabling the feature turns on both the visual affordance and the shortcut.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const omniEnabled = features.omniSearch && !isMobile;
  useEffect(() => {
    if (!omniEnabled) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [omniEnabled]);

  // Server-side time-in-app + retention pulse: ping on load, then every 2 min
  // while the tab is open. The route turns the first ping (or one after a long
  // gap) into app_opened and the rest into heartbeat (see app/api/heartbeat).
  useEffect(() => {
    const beat = () => { void fetch("/api/heartbeat", { method: "POST", keepalive: true }).catch(() => {}); };
    beat();
    const iv = setInterval(() => { if (!document.hidden) beat(); }, 120_000);
    return () => clearInterval(iv);
  }, []);

  // On a phone only one of these is mounted at a time; on desktop the same
  // elements sit side by side. Which pane shows is derived purely from the
  // selection state, so the titlebar "needs you" pill (which drives selection)
  // navigates correctly from any level.
  const mobilePane: "projects" | "tasks" | "session" | "settings" | "insights" =
    o.view === "settings" ? "settings" : o.view === "insights" ? "insights" : !project ? "projects" : !task ? "tasks" : "session";

  const projectsColumn = (
    <ProjectsColumn
      mobile={isMobile}
      width={layout.projW} onCollapse={() => o.setLayout((l) => ({ ...l, projCollapsed: true }))}
      projects={o.activeProjects} deprecated={o.deprecatedProjects} selId={selProj} running={o.running}
      onSelect={o.selectProject} onNew={() => o.setModal("project")} onOpenTweaks={() => o.setTweaksOpen((t) => !t)}
      onReorder={o.reorderProjects} onRestore={(id) => o.setDeprecated(id, false)}
      settingsActive={o.view === "settings"} onOpenSettings={() => openSettings()}
    />
  );

  const tasksColumn = project && (
    <TasksColumn
      mobile={isMobile}
      onBack={isMobile ? () => window.history.back() : undefined}
      width={layout.taskW} onCollapse={() => o.setLayout((l) => ({ ...l, taskCollapsed: true }))}
      project={project} agents={o.agents} tasks={o.realTasks} suggested={o.suggested} selTaskId={selTask} running={o.running} blockedBy={o.blockedBy}
      loading={o.tasksLoading}
      onSelectTask={o.setSelTask} onNewTask={() => o.setModal("task")} onEditContext={() => o.setModal("context")}
      onShowSessions={() => o.setModal("sessions")} onShowRecap={() => o.setSelTask(null)} onEditTask={o.setEditId}
      onStartSuggestion={o.startSuggestion} onAcceptSuggestion={o.acceptSuggestion} onDismissSuggestion={o.dismissSuggestion}
    />
  );

  const sessionColumn = (
    <div className="col col-session">
      {project?.seeded === 1 && !isMobile && <WelcomeCoach />}
      <div className="session-body">
        {task && project ? (
          <SessionView
            key={task.id}
            mobile={isMobile}
            onBack={isMobile ? () => window.history.back() : undefined}
            project={project} task={task} agents={o.agents} messages={o.messages} running={o.running.has(task.id)} blockedBy={o.blockedBy.get(task.id)}
            transcriptLoading={o.transcriptLoading}
            onSend={(text) => o.runTurn(task.id, text, false)}
            onStart={() => o.runTurn(task.id, "", true)}
            onStop={() => o.stopTurn(task.id)}
            onClear={() => o.clearSession(task.id)} onEdit={() => o.setEditId(task.id)}
            onSetStatus={o.setStatus} onSetPriority={o.setPriority} onSetModel={o.setModel}
            onSetReasoning={o.setReasoning} onSetPermission={o.setPermission}
            onResolveWithAI={o.resolveConflictsWithAI}
            onMerged={o.onMerged}
            onPrCreated={o.onPrCreated}
            onAnswer={(askId, questions, answers) => o.answerQuestion(task.id, askId, questions, answers)}
            onCancelQueued={(pendingId) => o.cancelQueued(task.id, pendingId)}
            railW={layout.railW}
            onRailWidth={(w) => o.setLayout((l) => ({ ...l, railW: w }))}
            onRailReset={() => o.setLayout((l) => ({ ...l, railW: DEFAULT_LAYOUT.railW }))}
            railCollapsed={layout.railCollapsed}
            onRailCollapse={() => o.setLayout((l) => ({ ...l, railCollapsed: true }))}
            onRailExpand={() => o.setLayout((l) => ({ ...l, railCollapsed: false }))}
          />
        ) : project ? (
          <ProjectLanding
            project={project}
            recap={o.recaps[project.id]}
            onNewTask={() => o.setModal("task")}
            onRefreshRecap={() => o.fetchRecap(project.id, true)}
          />
        ) : (
          <div className="empty" style={{ margin: "auto" }}>
            <div className="e-ic">{Icon.bolt()}</div>
            <div className="e-t">No task selected</div>
            <div className="e-s">Create a task to start an agent session.</div>
          </div>
        )}
      </div>
      {project && features.services && o.servicesMounted && !isMobile && (
        <ServicesDrawer
          key={`svc-${project.id}`}
          projectId={project.id}
          hasConfig={!!(project.dev_command || project.setup_command || project.test_command)}
          visible={o.servicesOpen}
          height={o.servicesHeight}
          onClose={() => o.setServicesOpen(false)}
          onResize={o.setServicesHeight}
        />
      )}
      {project && o.termMounted && !isMobile && (
        <TerminalDrawer
          key={project.id}
          cwd={project.repo_path}
          port={project.port}
          visible={o.termOpen}
          height={o.termHeight}
          onClose={() => o.setTermOpen(false)}
          onResize={o.setTermHeight}
        />
      )}
    </div>
  );

  const insightsColumn = (
    <InsightsView agents={o.agents} onClose={() => o.setView("workspace")} />
  );

  const settingsColumn = (
    <SettingsView
      key={settingsSection ?? "default"}
      settings={o.settings}
      setSetting={o.setSetting}
      appDefaults={o.appDefaults}
      setAppDefault={o.setAppDefault}
      agents={o.agents}
      onReset={o.resetSettings}
      onRerunSetup={o.rerunOnboarding}
      onClose={() => o.setView("workspace")}
      initialSection={settingsSection}
    />
  );

  return (
    <div className={`app${isMobile ? " mobile" : ""}`}>
      <div className="titlebar">
        <div className="tb-left">
          <div className="tb-logo" title="Operator">
            <span className="tb-ring"><span className="tb-core" /><span className="tb-arc" /></span>
            <span className="tb-word">OPERATOR</span>
          </div>
          {!isMobile && (
            <>
              <span className="tb-div" />
              <div className="tb-crumb">
                <span className="cz">fleet</span><span className="cs">/</span>
                <span className="cn">{o.view === "insights" ? "insights" : project ? project.name : "—"}</span>
              </div>
            </>
          )}
        </div>

        {omniEnabled && (
          <button className="tb-omni" onClick={() => setPaletteOpen(true)} title="Command palette — jump to a project, session, or command">
            <span className="omni-ic">{Icon.search()}</span>
            <span className="omni-txt">Jump to project, session, or command…</span>
            <span className="omni-k">⌘K</span>
          </button>
        )}

        <div className="tb-right">
          {o.needsYouTotal > 0 && (
            <div style={{ position: "relative" }}>
              <button
                className="needs-you-pill"
                onClick={(e) => { e.stopPropagation(); setNeedsYouOpen((v) => !v); }}
                title="Pick a task waiting on your input"
              >
                <span className="ny-dot" />
                {o.needsYouTotal} NEED YOU
              </button>
              {needsYouOpen && (
                <NeedsYouMenu
                  onJump={(projectId, taskId) => o.goToTask(projectId, taskId)}
                  onClose={() => setNeedsYouOpen(false)}
                />
              )}
            </div>
          )}
          {isMobile && project && (
            <button
              className={`tb-icon${o.termOpen ? " on" : ""}`}
              title="Terminal (runs in the project's working dir)" aria-label="Terminal"
              onClick={() => { o.setTermMounted(true); o.setTermOpen((t) => !t); }}
            >
              {Icon.terminal()}
            </button>
          )}

          <div className="tb-actions">
            {features.services && (
              <button
                className={`tb-btn${o.servicesOpen ? " on" : ""}`}
                disabled={!project}
                title={project ? "Toggle the project's managed services (dev server, setup, test)" : "Select a project first"}
                onClick={() => { if (!project) return; o.setServicesMounted(true); o.setServicesOpen((s) => !s); }}
              >
                {Icon.sliders()} Services
              </button>
            )}
            <button
              className={`tb-btn${o.termOpen ? " on" : ""}`}
              disabled={!project}
              title={project ? "Toggle terminal (runs in the project's working dir)" : "Select a project first"}
              onClick={() => { if (!project) return; o.setTermMounted(true); o.setTermOpen((t) => !t); }}
            >
              {Icon.terminal()} Terminal
            </button>
            <button className="tb-btn" onClick={() => o.setTweaksOpen((t) => !t)} title="Tweaks">{Icon.sliders()} Tweaks</button>
          </div>

          <button
            className={`tb-icon${o.view === "insights" ? " on" : ""}`}
            title="Insights — spend, tokens, tasks shipped, code merged" aria-label="Insights"
            onClick={() => o.setView(o.view === "insights" ? "workspace" : "insights")}
          >
            {Icon.chart()}
          </button>
          <button className="tb-icon" title={isDark ? "Switch to light theme" : "Switch to dark theme"} aria-label="Toggle theme" onClick={() => o.setTweak("theme", isDark ? "light" : "dark")}>
            {isDark ? Icon.sun() : Icon.moon()}
          </button>
          <div className="tb-avatar" title={o.accessEmail ? `Signed in: ${o.accessEmail}` : "Your workspace"}>
            {(o.accessEmail?.[0] ?? "A").toUpperCase()}
          </div>
        </div>
      </div>

      <div className={`body${isMobile ? " mobile" : ""}`}>
        {o.bootError ? (
          // The very first fetch failed — nothing to render behind this, so a
          // centered retry beats an empty workspace that looks "hung".
          <div className="empty" style={{ margin: "auto" }}>
            <div className="e-ic">{Icon.bolt()}</div>
            <div className="e-t">Couldn&apos;t reach the workspace</div>
            <div className="e-s">{o.bootError}</div>
            <button className="btn btn-line" style={{ marginTop: 16 }} onClick={o.retryBoot}>{Icon.restore()} Retry</button>
          </div>
        ) : !o.booted ? (
          <BootSkeleton mobile={isMobile} />
        ) : isMobile ? (
          mobilePane === "projects" ? projectsColumn
            : mobilePane === "settings" ? settingsColumn
            : mobilePane === "insights" ? insightsColumn
            : mobilePane === "tasks" ? tasksColumn
            : sessionColumn
        ) : (
          <>
            {layout.projCollapsed ? (
              <ColRail label="Projects" onExpand={() => o.setLayout((l) => ({ ...l, projCollapsed: false }))} />
            ) : (
              <>
                {projectsColumn}
                <ColResize
                  min={PROJ_W.min} max={PROJ_W.max}
                  onWidth={(w) => o.setLayout((l) => ({ ...l, projW: w }))}
                  onReset={() => o.setLayout((l) => ({ ...l, projW: DEFAULT_LAYOUT.projW }))}
                />
              </>
            )}

            {o.view === "settings" ? settingsColumn : o.view === "insights" ? insightsColumn : (
              <>
                {project ? (
                  layout.taskCollapsed ? (
                    <ColRail label="Tasks" task onExpand={() => o.setLayout((l) => ({ ...l, taskCollapsed: false }))} />
                  ) : (
                    <>
                      {tasksColumn}
                      <ColResize
                        min={TASK_W.min} max={TASK_W.max}
                        onWidth={(w) => o.setLayout((l) => ({ ...l, taskW: w }))}
                        onReset={() => o.setLayout((l) => ({ ...l, taskW: DEFAULT_LAYOUT.taskW }))}
                      />
                    </>
                  )
                ) : (
                  // First-run (or everything deprecated): make the empty shell a
                  // doorway, not a dead end — explain what a project is and offer
                  // the create action right here.
                  <div className="col col-tasks">
                    <div className="empty" style={{ margin: "auto", maxWidth: 300 }}>
                      <div className="e-ic">{Icon.folder()}</div>
                      <div className="e-t">{o.projects.length > 0 ? "No active projects" : "No projects yet"}</div>
                      <div className="e-s">
                        {o.projects.length > 0
                          ? "Everything is deprecated — restore a project from the sidebar, or start a new one."
                          : "Each project is an app you're building: its own working directory, context, and agent sessions."}
                      </div>
                      <button className="btn btn-accent" style={{ marginTop: 16 }} onClick={() => o.setModal("project")}>
                        {Icon.plus()} {o.projects.length > 0 ? "New project" : "Create your first project"}
                      </button>
                    </div>
                  </div>
                )}

                {sessionColumn}
              </>
            )}
          </>
        )}
      </div>

      {o.modal === "task" && project && <NewTaskModal project={project} agents={o.agents} tasks={o.realTasks} onClose={() => o.setModal(null)} onCreate={o.createTask} onOpenSetup={o.rerunOnboarding} />}
      {o.editId && o.tasks.find((t) => t.id === o.editId) && (
        <EditTaskModal task={o.tasks.find((t) => t.id === o.editId)!} tasks={o.realTasks} onClose={() => o.setEditId(null)} onSave={o.saveTask} onDelete={o.removeTask} />
      )}
      {o.modal === "context" && project && <ContextModal project={project} agents={o.agents} onSetDefaultAgent={o.setProjectDefaultAgent} onClose={() => o.setModal(null)} onSave={o.saveContext} onDelete={() => o.removeProject(project.id)} onDeprecate={() => o.setDeprecated(project.id, true)} />}
      {o.modal === "project" && <NewProjectModal onClose={() => o.setModal(null)} onCreate={o.createProject} />}
      {o.modal === "sessions" && project && (
        <SessionsModal
          project={project}
          onClose={() => o.setModal(null)}
          onJump={(taskId) => { o.setSelTask(taskId); o.setModal(null); }}
        />
      )}

      {/* ⌘K palette. Commands are assembled here (not inside the palette) so each
          row can close over the same handlers the top bar and rails use; rows that
          need a project/task are simply omitted when there isn't one. */}
      {paletteOpen && (
        <CommandPalette
          projects={o.activeProjects}
          commands={([
            { id: "new-project", label: "New project", keywords: "create add repo", icon: Icon.plus(), run: () => o.setModal("project") },
            project && { id: "new-task", label: "New task", hint: `in ${project.name}`, keywords: "new session create start", icon: Icon.plus(), run: () => o.setModal("task") },
            { id: "toggle-theme", label: "Toggle theme", hint: isDark ? "switch to light" : "switch to dark", keywords: "dark light mode appearance", icon: isDark ? Icon.sun() : Icon.moon(), run: () => o.setTweak("theme", isDark ? "light" : "dark") },
            { id: "open-settings", label: "Open Settings", keywords: "preferences defaults setup", icon: Icon.gear(), run: () => openSettings() },
            { id: "open-insights", label: "Open Insights", keywords: "usage spend cost tokens analytics dashboard metrics stats", icon: Icon.chart(), run: () => o.setView("insights") },
            { id: "connect-agent", label: "Connect an agent", keywords: "codex claude agent connect login subscription", icon: Icon.bolt(), run: () => openSettings("agents") },
            { id: "open-tweaks", label: "Open Tweaks", keywords: "appearance accent density theme", icon: Icon.sliders(), run: () => o.setTweaksOpen(true) },
            project && features.services && { id: "toggle-services", label: "Toggle Services", hint: o.servicesOpen ? "hide" : "show", keywords: "dev server setup test drawer", icon: Icon.sliders(), run: () => { o.setServicesMounted(true); o.setServicesOpen((s) => !s); } },
            project && { id: "toggle-terminal", label: "Toggle Terminal", hint: o.termOpen ? "hide" : "show", keywords: "shell console pty", icon: Icon.terminal(), run: () => { o.setTermMounted(true); o.setTermOpen((t) => !t); } },
            task && task.started === 1 && !o.running.has(task.id) && { id: "clear-session", label: "/clear current session", hint: task.title, keywords: "new session restart fresh context compact", icon: Icon.clear(), run: () => { void o.clearSession(task.id); } },
          ] as (PaletteCommand | false | null)[]).filter((c): c is PaletteCommand => !!c)}
          onPickProject={o.selectProject}
          onPickTask={o.goToTask}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {o.tweaksOpen && <TweaksPanel tweaks={o.tweaks} setTweak={o.setTweak} onClose={() => o.setTweaksOpen(false)} />}

      {/* Phone terminal lives as a full-screen sheet over everything. Kept mounted
          (hidden) while a project is selected so a dev server survives pane hops. */}
      {isMobile && project && o.termMounted && (
        <MobileTerminalSheet key={project.id} cwd={project.repo_path} port={project.port} visible={o.termOpen} onClose={() => o.setTermOpen(false)} />
      )}

      {/* First-run onboarding — a full-screen wizard over the (empty) workspace
          on a fresh instance, or when re-run from Settings. */}
      {o.wizardOpen && o.onboarding && (
        <OnboardingWizard initial={o.onboarding} onFinish={o.finishWizard} />
      )}

      {/* Optional post-setup nudge to connect a second agent (Codex). Only once
          the required first-run wizard is done, and never stacked on the wizard
          or the tutorial-payoff modal. Dismissible once (localStorage). */}
      {o.onboarding?.complete && !o.wizardOpen && !o.nudge && (
        <AgentNudge ready onConnect={() => openSettings("agents")} />
      )}

      {/* Post-tutorial payoff: fires once the seeded "Welcome" task is merged. */}
      {o.nudge && (
        <WelcomeNudge
          onClose={() => o.setNudge(false)}
          onCreateProject={() => { o.setNudge(false); o.setModal("project"); }}
        />
      )}
    </div>
  );
}
