"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "../icons";
import { jget, jsend } from "./api";
import { AgentConnect } from "./AgentConnect";
import type { AgentInfoT, AgentsResponseT, ClaudeVerifyT, OnboardingT, OnbStep } from "./types";

// The first-run wizard, trimmed to the two irreducible auth steps: connect a
// coding agent, then verify it responds. "An agent" — not Claude specifically:
// every registered driver (Claude Code, Codex, …) is offered via the same
// generic AgentConnect card the Settings surface uses, and connecting ANY of
// them satisfies the step, so a Codex-only first run completes cleanly (the
// server adopts the connected agent as the default on finish — lib/onboarding).
// Claude stays the recommended tab. Everything else — creating a real project —
// is deferred until after the built-in "Welcome" tutorial. State persists
// server-side (lib/onboarding) so abandoning mid-way resumes at the right step;
// it's re-runnable from Settings and skippable for power users.

const STEPS: { id: OnbStep; label: string; icon: () => React.ReactNode }[] = [
  { id: "connect", label: "Connect an agent", icon: Icon.bolt },
  { id: "verify", label: "Verify", icon: Icon.check },
];

export function OnboardingWizard({
  initial,
  onFinish,
}: {
  initial: OnboardingT;
  onFinish: () => void;
}) {
  // Older/persisted states may resume on a step that no longer exists ("project"
  // / "notifications"); collapse anything that isn't "verify" back to "connect".
  const [step, setStep] = useState<OnbStep>(initial.step === "verify" ? "verify" : "connect");
  const [bundle, setBundle] = useState<AgentsResponseT | null>(null);
  // The agent connected during THIS wizard run — the one the Verify step tests.
  // On resume (nothing connected this run) fall back to any connected agent.
  const [justConnected, setJustConnected] = useState<string | null>(null);
  const idx = STEPS.findIndex((s) => s.id === step);

  const load = useCallback(() => {
    jget<AgentsResponseT>("/api/agents").then(setBundle).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const connected = (bundle?.agents ?? []).filter((a) => a.connected);
  const verifyAgent =
    (justConnected && connected.find((a) => a.id === justConnected)) || connected[0] || null;

  // Persist the resume point whenever the step changes (fire-and-forget).
  const goto = useCallback((s: OnbStep) => {
    setStep(s);
    jsend("/api/onboarding", "PATCH", { step: s }).catch(() => {});
  }, []);

  const finish = useCallback(() => {
    jsend("/api/onboarding", "POST").catch(() => {});
    onFinish();
  }, [onFinish]);

  return (
    <div className="wiz-scrim">
      <div className="wiz">
        <div className="wiz-rail">
          <div className="wiz-brand"><span className="glyph">{Icon.bolt()}</span> Operator</div>
          <div className="wiz-rail-sub">Let&apos;s get you set up</div>
          <div className="wiz-steps">
            {STEPS.map((s, i) => (
              <div key={s.id} className={`wiz-stepitem${i === idx ? " active" : ""}${i < idx ? " done" : ""}`}>
                <span className="wiz-stepnum">{i < idx ? Icon.check() : s.icon()}</span>
                <span className="wiz-steplabel">{s.label}</span>
              </div>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          <button className="btn btn-ghost btn-sm wiz-skip" onClick={finish} title="Skip setup — you can re-run it from Settings">
            Skip setup
          </button>
        </div>

        <div className="wiz-main">
          {step === "connect" && (
            <ConnectStep
              bundle={bundle}
              done={connected.length > 0}
              onConnected={(id) => { setJustConnected(id); load(); }}
              onContinue={() => goto("verify")}
            />
          )}
          {step === "verify" && (
            <VerifyStep agent={verifyAgent} onBack={() => goto("connect")} onFinish={finish} />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- step shell ----------

function StepHead({ n, title, sub }: { n: number; title: string; sub: React.ReactNode }) {
  return (
    <div className="wiz-head">
      <div className="wiz-step-tag">Step {n} of {STEPS.length}</div>
      <div className="wiz-title">{title}</div>
      <div className="wiz-sub">{sub}</div>
    </div>
  );
}

// ---------- Step 1: Connect an agent ----------

// One tab per registered driver, each rendering the same generic AgentConnect
// card (subscription sign-in + API-key path) the Settings surface uses — so
// agent #3 shows up here with zero wizard edits. Connecting any ONE agent
// unlocks Continue; the rest can be added later from Settings → Agents.
function ConnectStep({
  bundle,
  done,
  onConnected,
  onContinue,
}: {
  bundle: AgentsResponseT | null;
  done: boolean;
  onConnected: (agentId: string) => void;
  onContinue: () => void;
}) {
  const agents = bundle?.agents ?? [];
  const recommended = bundle?.default ?? "claude";
  const [selected, setSelected] = useState<string | null>(null);
  const current: AgentInfoT | undefined =
    agents.find((a) => a.id === (selected ?? recommended)) ?? agents[0];

  return (
    <>
      <StepHead
        n={1}
        title="Connect a coding agent"
        sub="Operator runs coding agents as you. Sign in with the account you already have — connect one now, add others any time from Settings."
      />
      <div className="wiz-body">
        {!bundle && <div className="wiz-verify"><span className="wiz-spin" /> <span>Loading agents…</span></div>}
        {agents.length > 1 && (
          <div className="seg" style={{ maxWidth: 460, marginBottom: 20 }}>
            {agents.map((a) => (
              <button key={a.id} className={current?.id === a.id ? "on" : ""} onClick={() => setSelected(a.id)}>
                {a.connected ? Icon.check() : Icon.bolt()} {a.label}
                {a.id === recommended ? " · recommended" : ""}
              </button>
            ))}
          </div>
        )}
        {current && (
          <AgentConnect key={current.id} agent={current} onConnected={() => onConnected(current.id)} />
        )}
      </div>
      <div className="wiz-foot">
        <span className="spacer" />
        <button className="btn btn-accent" disabled={!done} onClick={onContinue}>
          Continue {Icon.chevRight()}
        </button>
      </div>
    </>
  );
}

// ---------- Step 2: Verify ----------

function VerifyStep({
  agent,
  onBack,
  onFinish,
}: {
  agent: AgentInfoT | null;
  onBack: () => void;
  onFinish: () => void;
}) {
  const [state, setState] = useState<"running" | "ok" | "fail">("running");
  const [result, setResult] = useState<ClaudeVerifyT | null>(null);
  const label = agent?.label ?? "your agent";

  const run = useCallback(() => {
    if (!agent) return;
    setState("running");
    setResult(null);
    jsend<ClaudeVerifyT>(`/api/agents/${agent.id}/verify`, "POST")
      .then((r) => { setResult(r); setState(r.connected ? "ok" : "fail"); })
      .catch((e) => { setResult({ connected: false, email: null, plan: null, method: null, error: e instanceof Error ? e.message : String(e) }); setState("fail"); });
  }, [agent]);

  useEffect(() => { run(); }, [run]);

  return (
    <>
      <StepHead
        n={2}
        title="Verify the connection"
        sub={`Running a one-shot test turn to confirm ${label} responds. Next you'll land on a 2-minute tutorial that shows the whole loop.`}
      />
      <div className="wiz-body">
        {(!agent || state === "running") && (
          <div className="wiz-verify"><span className="wiz-spin" /> <span>Testing your {label} connection…</span></div>
        )}
        {agent && state === "ok" && (
          <div className="wiz-connected">
            <span className="wiz-ok">{Icon.check()}</span>
            <div>
              <div className="wiz-ok-t">
                Connected{result?.email ? <> as <strong>{result.email}</strong></> : ""}{result?.plan ? ` (${result.plan})` : ""}
              </div>
              <div className="hlp" style={{ margin: "3px 0 0" }}>The test turn completed — your sessions are ready to run.</div>
            </div>
          </div>
        )}
        {agent && state === "fail" && (
          <div className="field" style={{ maxWidth: 600 }}>
            <div className="wiz-fail">
              <span className="wiz-failic">{Icon.x()}</span>
              <div>
                <div className="wiz-ok-t">Couldn&apos;t reach {label}</div>
                <div className="hlp" style={{ margin: "4px 0 0" }}>{result?.error ?? "unknown error"}</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button className="btn btn-accent" onClick={run}>{Icon.restore()} Retry</button>
              <button className="btn btn-line" onClick={onBack}>{Icon.chevRight({ style: { transform: "rotate(180deg)" } })} Back to connect</button>
            </div>
          </div>
        )}
      </div>
      <div className="wiz-foot">
        <button className="btn btn-ghost" onClick={onBack}>Back</button>
        <span className="spacer" />
        <button className="btn btn-accent" disabled={state !== "ok"} onClick={onFinish}>Start the tutorial {Icon.chevRight()}</button>
      </div>
    </>
  );
}
