"use client";

import { useEffect, useState } from "react";
import { Icon } from "../icons";
import { DEFAULT_SETTINGS, reasoningOptions, permissionOptions, type Settings, type AgentsBundle } from "./types";
import { capsFor, agentLabel } from "./agents";
import { GitHubSettings } from "./github";
import { WorktreePrune } from "./WorktreePrune";
import { AgentConnect } from "./AgentConnect";
import { LoadNote } from "./shared";
import { jget } from "./api";
import type { AgentInfoT, AgentsResponseT } from "./types";

// Account / session panel. Shows who's signed in to this instance and a Logout
// control — but only when an origin provider is actually gating the box (first-
// party control-plane session or Cloudflare Access). In open local dev there's
// no session to end, so the panel says so and hides the button. The redirect
// target is provider-specific and decided server-side (see /api/auth/logout).
function AccountSection() {
  const [state, setState] = useState<
    { provider: string; signedIn: boolean; email: string | null } | null
  >(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/whoami")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setState(d);
      })
      .catch(() => {
        if (!cancelled) setState({ provider: "none", signedIn: false, email: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function logout() {
    setBusy(true);
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      // Top-level navigation so the CF logout (or CP login) loads as a real page.
      window.location.href = data?.redirect || "/";
    } catch {
      setBusy(false);
    }
  }

  return (
    <div className="field">
      <div className="lab">{Icon.lock()} Signed in</div>
      {state == null ? (
        <LoadNote style={{ padding: 0 }}>Checking your session…</LoadNote>
      ) : state.signedIn ? (
        <>
          <div className="hlp" style={{ marginTop: 0, marginBottom: 12 }}>
            {state.email ? <strong>{state.email}</strong> : "Signed in"}
          </div>
          <button
            className="btn btn-line"
            onClick={logout}
            disabled={busy}
            style={{ alignSelf: "flex-start" }}
          >
            {Icon.external()} {busy ? "Signing out…" : "Log out"}
          </button>
          <div className="hlp" style={{ marginTop: 10 }}>
            {state.provider === "cf-access"
              ? "Ends your Cloudflare Access session for this instance."
              : "Ends your session and returns you to the sign-in page."}
          </div>
        </>
      ) : (
        <div className="hlp" style={{ marginTop: 0 }}>
          This instance isn&apos;t behind a sign-in (local/open mode) — there&apos;s no session to end.
        </div>
      )}
    </div>
  );
}

// The "Agents" section: connect coding agents beyond the required first-run
// Claude one. Claude appears here as already-connected; Codex (and any future
// agent) gets a "connect another agent" card driven by AgentConnect against the
// generic /api/agents/[id]/* routes. Reads the same GET /api/agents the task
// pickers gate on, so connecting here immediately un-grays the agent there.
function AgentsSection({ defaultAgent, onChanged }: { defaultAgent: string; onChanged?: () => void }) {
  const [agents, setAgents] = useState<AgentInfoT[] | null>(null);
  const [def, setDef] = useState<string>(defaultAgent);

  const load = () =>
    jget<AgentsResponseT>("/api/agents")
      .then((r) => { setAgents(r.agents); setDef(r.default); })
      .catch(() => setAgents([]));
  useEffect(() => { load(); }, []);

  if (agents == null) return <LoadNote style={{ padding: 0 }}>Loading agents…</LoadNote>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div className="hlp" style={{ marginTop: 0 }}>
        Each task runs as a coding agent. Connect an agent&apos;s subscription login (or API key) once and it becomes selectable for new tasks. {def === "claude" ? "Claude is the default and runs the app's own jobs (summaries, recaps), so keep it connected." : ""}
      </div>
      {agents.map((a) => (
        <div key={a.id} className="field" style={{ marginBottom: 0 }}>
          <div className="lab" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {Icon.spark()} {a.label}
            {a.id === def && <span className="opt">— default</span>}
            {a.connected && (a.authBroken
              // Connected on record but its login died — a green check here would
              // contradict the card below it (and the titlebar banner).
              ? <span className="wiz-warn" style={{ marginLeft: "auto" }} title="Sign-in stopped working">{Icon.bolt()}</span>
              : <span className="wiz-ok" style={{ marginLeft: "auto" }}>{Icon.check()}</span>)}
          </div>
          <AgentConnect agent={a} compact onConnected={() => { load(); onChanged?.(); }} />
        </div>
      ))}
    </div>
  );
}

// The EFFECTIVE utility agent, resolved connected-first by the server
// (lib/agents/oneshots.ts). The buttons above show what's *configured*; this
// line shows what will actually run — they diverge whenever the configured
// agent isn't connected, and silently picking a different agent would be a
// worse surprise than saying so. When nothing is connected at all, internal
// jobs can't run, so this says that instead of naming a stand-in.
function UtilityEffective({ agents }: { agents: AgentsBundle }) {
  const u = agents.utility;
  if (!u) return null;
  if (!u.id)
    return (
      <div className="hlp" style={{ marginTop: 8 }}>
        {Icon.bolt()} No agent is connected — recaps and context refresh are paused. Connect one in Settings → Agents.
      </div>
    );
  const label = agentLabel(agents, u.id);
  return (
    <div className="hlp" style={{ marginTop: 8 }}>
      Running on <strong>{label}</strong>
      {u.fallback && <span className="opt"> (fallback — {agentLabel(agents, u.configured)} isn&apos;t connected)</span>}
    </div>
  );
}

// The settings surface is a two-pane view that replaces the work area: a category
// nav (left) + the active section's content (right). Sections are data-driven so
// growing settings is adding an entry here + a branch in renderSection — no layout
// work. Today there's one section; appearance/models/integrations slot in later.
const SETTINGS_SECTIONS: { id: string; label: string; icon: () => React.ReactNode }[] = [
  { id: "general", label: "General", icon: Icon.gear },
  { id: "background", label: "Background jobs", icon: Icon.clock },
  { id: "run", label: "Run defaults", icon: Icon.spark },
  { id: "agents", label: "Agents", icon: Icon.bolt },
  { id: "storage", label: "Storage", icon: Icon.archive },
  { id: "github", label: "GitHub", icon: Icon.github },
  { id: "account", label: "Account", icon: Icon.lock },
  { id: "setup", label: "Setup", icon: Icon.bolt },
];

export function SettingsView({ settings, setSetting, appDefaults, setAppDefault, agents, onAgentsRefresh, onReset, onRerunSetup, onClose, initialSection }: {
  settings: Settings;
  setSetting: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  appDefaults: Record<string, string>;
  setAppDefault: (key: string, value: string | null) => void;
  agents: AgentsBundle;
  onAgentsRefresh?: () => void;
  onReset: () => void;
  onRerunSetup: () => void;
  onClose: () => void;
  initialSection?: string;
}) {
  const [section, setSection] = useState<string>(
    initialSection && SETTINGS_SECTIONS.some((s) => s.id === initialSection) ? initialSection : SETTINGS_SECTIONS[0].id
  );
  // Which agent's run defaults are being edited (defaults are per-agent, keyed
  // "default_reasoning:<agent>"). Falls back to the app default agent.
  const appDefaultAgent = appDefaults.default_agent || agents.default;
  const [editAgent, setEditAgent] = useState(appDefaultAgent);
  const caps = capsFor(agents, editAgent);
  // Agent-scoped default, with legacy un-suffixed keys as a fallback (mirrors the
  // driver's resolution) so pre-existing settings still show as selected.
  const reasoningVal = appDefaults[`default_reasoning:${editAgent}`] ?? appDefaults.default_reasoning ?? null;
  const permissionVal = appDefaults[`default_permission_mode:${editAgent}`] ?? appDefaults.default_permission_mode ?? null;
  const multiAgent = agents.agents.length > 1;
  const backgroundJobs = appDefaults.background_jobs !== "off";
  const recapMode = appDefaults.recap_mode === "on_open" || appDefaults.recap_mode === "off"
    ? appDefaults.recap_mode
    : "automatic";
  // Whether agents may file unrequested follow-ups straight into the Suggested
  // tray. Default "ask_first" — see lib/suggestionPolicy.ts.
  const suggestionPolicy = appDefaults.suggestion_policy === "auto" ? "auto" : "ask_first";
  const [jobUsage, setJobUsage] = useState<Record<string, { runs: number; cost_usd: number }> | null>(null);
  useEffect(() => {
    if (section !== "background" || jobUsage !== null) return;
    jget<{ jobs: { job: string; runs: number; cost_usd: number }[] }>("/api/settings/background-jobs")
      .then((data) => setJobUsage(Object.fromEntries(data.jobs.map((j) => [j.job, { runs: j.runs, cost_usd: j.cost_usd }]))))
      .catch(() => setJobUsage({}));
  }, [jobUsage, section]);
  const recapUsage = jobUsage?.summarizeProjectRecap ?? { runs: 0, cost_usd: 0 };
  const utilityUsage = [jobUsage?.summarizeProjectRecap, jobUsage?.draftProjectContext]
    .filter((u): u is { runs: number; cost_usd: number } => !!u)
    .reduce((sum, u) => ({ runs: sum.runs + u.runs, cost_usd: sum.cost_usd + u.cost_usd }), { runs: 0, cost_usd: 0 });
  const usageLine = (label: string, usage = recapUsage) =>
    `${label} · ${usage.runs.toLocaleString()} ${usage.runs === 1 ? "run" : "runs"} · ~$${usage.cost_usd.toFixed(2)} in the last 30 days`;
  // Any server-backed run default set (agent-scoped, legacy, or default_agent)
  // means we're off the built-in defaults.
  const hasRunDefault = Object.keys(appDefaults).some((k) => k.startsWith("default_") || k === "utility_agent");
  const hasBackgroundDefault = !backgroundJobs || recapMode !== "automatic";
  const isDefault = settings.clearThresholdPct === DEFAULT_SETTINGS.clearThresholdPct
    && settings.clearThresholdTokens === DEFAULT_SETTINGS.clearThresholdTokens
    && !hasRunDefault
    && !hasBackgroundDefault;
  // Clamp on commit so a half-typed value never persists out of range.
  const clampPct = (n: number) => Math.min(100, Math.max(1, Math.round(n)));
  const clampTokens = (n: number) => Math.max(1000, Math.round(n));
  const active = SETTINGS_SECTIONS.find((s) => s.id === section) ?? SETTINGS_SECTIONS[0];
  return (
    <>
      <div className="col settings-nav">
        <div className="settings-nav-h">Settings</div>
        <div className="settings-nav-list">
          {SETTINGS_SECTIONS.map((s) => (
            <button key={s.id} className={`nav-item${section === s.id ? " active" : ""}`} onClick={() => setSection(s.id)}>
              {s.icon()} {s.label}
            </button>
          ))}
        </div>
        <div className="settings-nav-foot">{section === "background" ? "agent utility work · saved to this workspace" : section === "run" ? "run defaults · saved to this workspace" : section === "agents" ? "coding agent logins · stored in this workspace" : section === "storage" ? "disk cleanup · acts on this workspace" : section === "github" ? "GitHub connection · stored in this workspace" : section === "account" ? "your sign-in to this instance" : section === "setup" ? "first-run setup · stored in this workspace" : "app-level preferences · saved on this browser"}</div>
      </div>
      <div className="col col-session">
        <div className="settings-head">
          <div className="settings-title">{active.label}</div>
          <span className="spacer" />
          <button className="btn btn-ghost btn-sm" onClick={onReset} disabled={isDefault} title="Restore every setting to its default">{Icon.restore()} Reset to defaults</button>
          <button className="btn btn-line btn-sm" onClick={onClose}>{Icon.chevRight({ style: { transform: "rotate(180deg)" } })} Back to workspace</button>
        </div>
        <div className="scroll">
          <div className="settings-body">
            {section === "general" && (
              <>
                <div className="field">
                  <div className="lab">{Icon.clear()} /clear recommendation threshold</div>
                  <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
                    When a session&apos;s context window crosses either limit, the app nudges you to run <code>/clear</code> to start fresh. Whichever is hit first wins.
                  </div>
                  <div style={{ display: "flex", gap: 14, maxWidth: 420 }}>
                    <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                      <div className="lab">Percent of window <span className="opt">— %</span></div>
                      <input
                        type="number" min={1} max={100} value={settings.clearThresholdPct}
                        onChange={(e) => setSetting("clearThresholdPct", Number(e.target.value) || 0)}
                        onBlur={(e) => setSetting("clearThresholdPct", clampPct(Number(e.target.value) || DEFAULT_SETTINGS.clearThresholdPct))}
                      />
                    </div>
                    <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                      <div className="lab">Absolute tokens <span className="opt">— count</span></div>
                      <input
                        type="number" min={1000} step={1000} value={settings.clearThresholdTokens}
                        onChange={(e) => setSetting("clearThresholdTokens", Number(e.target.value) || 0)}
                        onBlur={(e) => setSetting("clearThresholdTokens", clampTokens(Number(e.target.value) || DEFAULT_SETTINGS.clearThresholdTokens))}
                      />
                    </div>
                  </div>
                  <div className="hlp" style={{ marginTop: 8 }}>
                    Defaults: {DEFAULT_SETTINGS.clearThresholdPct}% or {DEFAULT_SETTINGS.clearThresholdTokens.toLocaleString()} tokens.
                  </div>
                </div>
                <div className="field">
                  <div className="lab">{Icon.spark()} Suggested tasks</div>
                  <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
                    What an agent does when it spots follow-up work you didn&apos;t ask about. Either way, asking an agent to plan or break down work still fills the tray straight away.
                  </div>
                  <div className="seg" style={{ flexWrap: "wrap", maxWidth: 620 }}>
                    {([
                      ["ask_first", "Ask me first"],
                      ["auto", "Add them automatically"],
                    ] as const).map(([value, label]) => (
                      <button
                        key={value}
                        className={suggestionPolicy === value ? "on" : ""}
                        onClick={() => setAppDefault("suggestion_policy", value === "ask_first" ? null : value)}
                      >{label}</button>
                    ))}
                  </div>
                  <div className="hlp" style={{ marginTop: 10 }}>
                    {suggestionPolicy === "ask_first"
                      ? "Agents list what they'd propose in the chat and wait for your go-ahead before anything lands in the Suggested tray."
                      : "Agents add follow-ups to the Suggested tray as they notice them, without asking."}
                  </div>
                </div>
              </>
            )}
            {section === "background" && (
              <>
                <div className="field">
                  <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                    <div style={{ flex: 1 }}>
                      <div className="lab">{Icon.bolt()} Let Operator use your agent for background work</div>
                      <div className="hlp" style={{ marginTop: 4 }}>
                        Turn this off to stop unattended agent work. Things you explicitly ask for—such as <code>/clear</code>, Refresh with AI, or manually refreshing a recap—still run.
                      </div>
                    </div>
                    <button
                      role="switch"
                      aria-label="Let Operator use your agent for background work"
                      aria-checked={backgroundJobs}
                      className={`in-switch${backgroundJobs ? " on" : ""}`}
                      onClick={() => setAppDefault("background_jobs", backgroundJobs ? "off" : null)}
                    ><span /></button>
                  </div>
                  <div className="hlp" style={{ marginTop: 10 }}>{jobUsage === null ? "Loading last-30-day usage…" : usageLine("Project recap activity")}</div>
                </div>

                <div className="field">
                  <div className="lab">{Icon.clock()} Project recaps</div>
                  <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
                    Choose when Operator writes a fresh “where you left off” recap. Manual refreshes remain available in every mode.
                  </div>
                  <div className="seg" style={{ flexWrap: "wrap", maxWidth: 620 }}>
                    {([
                      ["automatic", "Automatic"],
                      ["on_open", "Only when I open a project"],
                      ["off", "Off"],
                    ] as const).map(([value, label]) => (
                      <button key={value} className={recapMode === value ? "on" : ""} onClick={() => setAppDefault("recap_mode", value === "automatic" ? null : value)}>{label}</button>
                    ))}
                  </div>
                  <div className="hlp" style={{ marginTop: 10 }}>{jobUsage === null ? "Loading last-30-day usage…" : usageLine("Project recaps")}</div>
                </div>

                <div className="field">
                  <div className="lab">{Icon.spark()} Utility agent</div>
                  <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
                    Put Operator&apos;s utility work on a cheaper or second login—for example, run recaps on Codex while keeping Claude quota for your main tasks.
                  </div>
                  <div className="seg" style={{ flexWrap: "wrap", maxWidth: 520 }}>
                    {agents.agents.map((a) => (
                      <button
                        key={a.id}
                        className={(appDefaults.utility_agent || agents.utility?.configured || appDefaultAgent) === a.id ? "on" : ""}
                        title={a.authenticated ? `Run utility jobs on ${a.label}` : `${a.label} isn't connected yet`}
                        onClick={() => setAppDefault("utility_agent", a.id)}
                      >
                        {a.label}{!a.authenticated && <span className="opt"> · not connected</span>}
                      </button>
                    ))}
                  </div>
                  <UtilityEffective agents={agents} />
                  <div className="hlp" style={{ marginTop: 10 }}>{jobUsage === null ? "Loading last-30-day usage…" : usageLine("Utility agent jobs", utilityUsage)}</div>
                </div>
              </>
            )}
            {section === "run" && (
              <>
                {multiAgent && (
                  <div className="field">
                    <div className="lab">{Icon.bolt()} Default agent</div>
                    <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
                      The agent new tasks use when a project hasn&apos;t set its own default. A task&apos;s agent is fixed once created.
                    </div>
                    <div className="seg" style={{ flexWrap: "wrap", maxWidth: 520 }}>
                      {agents.agents.map((a) => (
                        <button
                          key={a.id}
                          className={appDefaultAgent === a.id ? "on" : ""}
                          title={a.authenticated ? `Default new tasks to ${a.label}` : `${a.label} isn't connected yet`}
                          onClick={() => setAppDefault("default_agent", a.id)}
                        >
                          {a.label}{!a.authenticated && <span className="opt"> · not connected</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {multiAgent && (
                  <div className="field">
                    <div className="lab">Run defaults for</div>
                    <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
                      Each agent carries its own reasoning &amp; permission defaults — pick which to edit.
                    </div>
                    <div className="seg" style={{ flexWrap: "wrap", maxWidth: 520 }}>
                      {agents.agents.map((a) => (
                        <button key={a.id} className={editAgent === a.id ? "on" : ""} onClick={() => setEditAgent(a.id)}>{a.label}</button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="field">
                  <div className="lab">{Icon.spark()} Default reasoning level</div>
                  <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
                    The thinking level a task uses when its own picker is set to <strong>Default</strong>. Per-task choices always override this.
                  </div>
                  <div className="seg" style={{ flexWrap: "wrap", maxWidth: 520 }}>
                    {reasoningOptions(caps).map((r) => (
                      <button
                        key={r.label}
                        className={reasoningVal === r.value ? "on" : ""}
                        title={r.sub}
                        onClick={() => setAppDefault(`default_reasoning:${editAgent}`, r.value)}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <div className="lab">{Icon.lock()} Default permission mode</div>
                  <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
                    How tasks run when their own picker is set to the default. <strong>Plan mode</strong> proposes a plan without editing files.
                  </div>
                  <div className="seg" style={{ flexWrap: "wrap", maxWidth: 520 }}>
                    {permissionOptions(caps).map((p) => (
                      <button
                        key={p.label}
                        className={permissionVal === p.value ? "on" : ""}
                        title={p.sub}
                        onClick={() => setAppDefault(`default_permission_mode:${editAgent}`, p.value)}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
            {section === "agents" && <AgentsSection defaultAgent="claude" onChanged={onAgentsRefresh} />}
            {section === "storage" && <WorktreePrune />}
            {section === "github" && <GitHubSettings />}
            {section === "account" && <AccountSection />}
            {section === "setup" && (
              <div className="field">
                <div className="lab">{Icon.bolt()} First-run setup</div>
                <div className="hlp" style={{ marginTop: 0, marginBottom: 12 }}>
                  Re-run the guided setup to reconnect Claude, switch between your subscription and an API key, or add another project. Your existing projects and sessions are untouched.
                </div>
                <button className="btn btn-line" onClick={onRerunSetup} style={{ alignSelf: "flex-start" }}>
                  {Icon.restore()} Re-run setup wizard
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
