"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { jget, jsend } from "./api";
import type { ClaudeLoginT, ClaudeVerifyT, OnboardingT, OnbStep } from "./types";

// The first-run wizard, trimmed to the two irreducible auth steps: connect a
// Claude account, then verify it responds. Everything else — creating a real
// project — is deferred until *after* the user has run the built-in "Welcome"
// tutorial, so they see the loop work before being asked to configure anything.
// State persists server-side (lib/onboarding) so abandoning mid-way resumes at
// the right step; it's re-runnable from Settings and skippable for power users.

const STEPS: { id: OnbStep; label: string; icon: () => React.ReactNode }[] = [
  { id: "connect", label: "Connect Claude", icon: Icon.bolt },
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
  const [connected, setConnected] = useState<boolean>(!!initial.method);
  const idx = STEPS.findIndex((s) => s.id === step);

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
              account={initial.account}
              method={initial.method}
              onConnected={() => setConnected(true)}
              onContinue={() => goto("verify")}
            />
          )}
          {step === "verify" && (
            <VerifyStep onBack={() => goto("connect")} onFinish={finish} />
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

// ---------- Step 1: Connect Claude ----------

function ConnectStep({
  account,
  method,
  onConnected,
  onContinue,
}: {
  account: OnboardingT["account"];
  method: OnboardingT["method"];
  onConnected: () => void;
  onContinue: () => void;
}) {
  const [mode, setMode] = useState<"subscription" | "api_key">(method ?? "subscription");
  const [done, setDone] = useState<boolean>(!!method);

  return (
    <>
      <StepHead
        n={1}
        title="Connect Claude"
        sub="Operator runs coding agents as you. Sign in with your Claude account (Pro/Max) to get started."
      />
      <div className="wiz-body">
        <div className="seg" style={{ maxWidth: 460, marginBottom: 20 }}>
          <button className={mode === "subscription" ? "on" : ""} onClick={() => setMode("subscription")}>
            {Icon.bolt()} Sign in with Claude
          </button>
          <button className={mode === "api_key" ? "on" : ""} onClick={() => setMode("api_key")}>
            {Icon.lock()} I have an API key
          </button>
        </div>

        {mode === "subscription" ? (
          <ClaudeConnect
            account={account}
            alreadyConnected={method === "subscription"}
            onConnected={() => { setDone(true); onConnected(); }}
          />
        ) : (
          <ApiKeyConnect
            alreadyConnected={method === "api_key"}
            onConnected={() => { setDone(true); onConnected(); }}
          />
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

// Guided `claude auth login`: one click starts it, the authorize URL appears
// here (not buried in a terminal), the user opens it, signs in, and pastes the
// code back. Mirrors the GitHub connect flow. The session lives server-side, so
// closing/reopening resumes the same attempt.
function ClaudeConnect({
  account,
  alreadyConnected,
  onConnected,
}: {
  account: OnboardingT["account"];
  alreadyConnected: boolean;
  onConnected: () => void;
}) {
  const [login, setLogin] = useState<ClaudeLoginT | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [showLog, setShowLog] = useState(false);
  const [reconnect, setReconnect] = useState(false);
  const fired = useRef(false);

  // Rejoin a login already underway (modal closed mid-flow / page reload).
  useEffect(() => {
    jget<ClaudeLoginT | null>("/api/claude/login")
      .then((l) => { if (l && l.status !== "idle") setLogin(l); })
      .catch(() => {});
  }, []);

  const start = async () => {
    setBusy(true);
    setCode("");
    try {
      setLogin(await jsend<ClaudeLoginT>("/api/claude/login", "POST"));
    } catch (e) {
      setLogin({ status: "error", url: null, email: null, plan: null, log: "", error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  // Poll while the CLI waits for the user to authorize / exchange the code.
  useEffect(() => {
    if (!login || (login.status !== "starting" && login.status !== "awaiting" && login.status !== "submitting")) return;
    const t = setInterval(() => {
      jget<ClaudeLoginT>("/api/claude/login").then((l) => {
        setLogin(l);
        if (l.status === "success" && !fired.current) { fired.current = true; onConnected(); }
      }).catch(() => {});
    }, 1800);
    return () => clearInterval(t);
  }, [login, onConnected]);

  const submitCode = async () => {
    if (!code.trim()) return;
    setBusy(true);
    try {
      const l = await jsend<ClaudeLoginT>("/api/claude/login/code", "POST", { code: code.trim() });
      setLogin(l);
      if (l.status === "success" && !fired.current) { fired.current = true; onConnected(); }
    } catch (e) {
      setLogin((p) => ({ ...(p as ClaudeLoginT), status: "error", error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  // Already connected from a prior run — offer to keep it or reconnect.
  if (alreadyConnected && !reconnect && (!login || login.status === "idle")) {
    return (
      <div className="wiz-connected">
        <span className="wiz-ok">{Icon.check()}</span>
        <div>
          <div className="wiz-ok-t">Claude is connected{account?.email ? <> as <strong>{account.email}</strong></> : ""}{account?.plan ? ` (${account.plan})` : ""}</div>
          <div className="hlp" style={{ margin: "3px 0 0" }}>Continue, or <button className="linkbtn" onClick={() => { setReconnect(true); start(); }}>reconnect a different account</button>.</div>
        </div>
      </div>
    );
  }

  if (login?.status === "success") {
    return (
      <div className="wiz-connected">
        <span className="wiz-ok">{Icon.check()}</span>
        <div className="wiz-ok-t">
          Signed in{login.email ? <> as <strong>{login.email}</strong></> : ""}{login.plan ? ` (${login.plan})` : ""}
        </div>
      </div>
    );
  }

  if (login?.status === "error") {
    return (
      <div className="field" style={{ maxWidth: 560 }}>
        <div className="hlp" style={{ marginTop: 0, color: "var(--red)" }}>⚠ {login.error ?? "sign-in failed"}</div>
        <button className="btn btn-line" onClick={start} disabled={busy} style={{ alignSelf: "flex-start" }}>{Icon.restore()} Try again</button>
        <LogToggle log={login.log} show={showLog} setShow={setShowLog} />
      </div>
    );
  }

  if (login && (login.status === "awaiting" || login.status === "submitting")) {
    return (
      <div className="wiz-codecard">
        <div className="hlp" style={{ marginTop: 0 }}>1. Open this link, sign in to your Claude account, and copy the code it shows:</div>
        <div style={{ display: "flex", gap: 10, margin: "10px 0 16px", flexWrap: "wrap" }}>
          <a className="btn btn-accent" href={login.url ?? undefined} target="_blank" rel="noreferrer">{Icon.bolt()} Open sign-in page</a>
          <button className="btn btn-line" onClick={() => login.url && navigator.clipboard?.writeText(login.url)}>Copy link</button>
        </div>
        <div className="hlp" style={{ marginTop: 0 }}>2. Paste the code here:</div>
        <div style={{ display: "flex", gap: 8, marginTop: 8, maxWidth: 460 }}>
          <input
            type="text" className="ctx-mono" autoFocus value={code} placeholder="paste authorization code"
            style={{ flex: 1, minWidth: 0 }}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitCode(); }}
          />
          <button className="btn btn-accent" disabled={busy || !code.trim()} onClick={submitCode}>
            {login.status === "submitting" || busy ? "Verifying…" : "Submit"}
          </button>
        </div>
        <LogToggle log={login.log} show={showLog} setShow={setShowLog} />
      </div>
    );
  }

  if (login?.status === "starting") {
    return <div className="hlp">Starting sign-in… preparing your authorization link.</div>;
  }

  // idle — initial CTA
  return (
    <div className="field" style={{ maxWidth: 560 }}>
      <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
        You&apos;ll get a sign-in link to open in any browser. This stores your login in this workspace and survives restarts — you only do it once.
      </div>
      <button className="btn btn-accent" disabled={busy} onClick={start} style={{ alignSelf: "flex-start" }}>
        {Icon.bolt()} {busy ? "Starting…" : "Connect Claude account"}
      </button>
    </div>
  );
}

function LogToggle({ log, show, setShow }: { log: string; show: boolean; setShow: (b: boolean) => void }) {
  if (!log) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <button className="linkbtn" onClick={() => setShow(!show)}>{show ? "Hide" : "Show"} terminal output</button>
      {show && <pre className="wiz-termlog">{log}</pre>}
    </div>
  );
}

function ApiKeyConnect({ alreadyConnected, onConnected }: { alreadyConnected: boolean; onConnected: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(alreadyConnected);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await jsend("/api/claude/api-key", "POST", { key: key.trim() });
      setSaved(true);
      onConnected();
    } catch (e) {
      setErr((e instanceof Error ? e.message : String(e)).replace(/^\d+\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  if (saved && !key) {
    return (
      <div className="wiz-connected">
        <span className="wiz-ok">{Icon.check()}</span>
        <div>
          <div className="wiz-ok-t">API key saved</div>
          <div className="hlp" style={{ margin: "3px 0 0" }}>Billed per-token against your Anthropic account. <button className="linkbtn" onClick={() => { setSaved(false); }}>Replace key</button></div>
        </div>
      </div>
    );
  }

  return (
    <div className="field" style={{ maxWidth: 560 }}>
      <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
        Paste an Anthropic API key (<code>sk-ant-…</code>). It&apos;s stored in this workspace only and used to bill Claude usage per-token. Most people should use the subscription sign-in instead.
      </div>
      <div style={{ display: "flex", gap: 8, maxWidth: 520 }}>
        <input type="password" className="ctx-mono" value={key} placeholder="sk-ant-…" style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && key.trim()) save(); }} />
        <button className="btn btn-accent" disabled={busy || !key.trim()} onClick={save}>{busy ? "Saving…" : "Save key"}</button>
      </div>
      {err && <div className="hlp" style={{ color: "var(--red)", marginTop: 8 }}>⚠ {err}</div>}
    </div>
  );
}

// ---------- Step 2: Verify ----------

function VerifyStep({ onBack, onFinish }: { onBack: () => void; onFinish: () => void }) {
  const [state, setState] = useState<"running" | "ok" | "fail">("running");
  const [result, setResult] = useState<ClaudeVerifyT | null>(null);

  const run = useCallback(() => {
    setState("running");
    setResult(null);
    jsend<ClaudeVerifyT>("/api/claude/verify", "POST")
      .then((r) => { setResult(r); setState(r.connected ? "ok" : "fail"); })
      .catch((e) => { setResult({ connected: false, email: null, plan: null, method: null, error: e instanceof Error ? e.message : String(e) }); setState("fail"); });
  }, []);

  useEffect(() => { run(); }, [run]);

  return (
    <>
      <StepHead n={2} title="Verify the connection" sub="Running a one-shot test turn to confirm Claude responds. Next you'll land on a 2-minute tutorial that shows the whole loop." />
      <div className="wiz-body">
        {state === "running" && (
          <div className="wiz-verify"><span className="wiz-spin" /> <span>Testing your Claude connection…</span></div>
        )}
        {state === "ok" && (
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
        {state === "fail" && (
          <div className="field" style={{ maxWidth: 600 }}>
            <div className="wiz-fail">
              <span className="wiz-failic">{Icon.x()}</span>
              <div>
                <div className="wiz-ok-t">Couldn&apos;t reach Claude</div>
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
