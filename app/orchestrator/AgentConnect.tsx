"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { jget, jsend } from "./api";
import { Modal } from "./Modal";
import type { AgentInfoT, AgentsResponseT, AgentLoginT, ClaudeVerifyT } from "./types";

const NUDGE_DISMISSED = "orch_agent_nudge_dismissed";

// Post-setup nudge: once the required Claude connection is done, gently suggest
// connecting the other available agents (Codex) so tasks can run on them too.
// Optional and dismissible (once, via localStorage) — the wizard never requires
// a second agent. Renders nothing until it confirms there's an unconnected agent
// to offer, so it never flashes for a single-agent instance.
export function AgentNudge({ ready, onConnect }: { ready: boolean; onConnect: () => void }) {
  const [pending, setPending] = useState<AgentInfoT[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!ready) return;
    try { if (localStorage.getItem(NUDGE_DISMISSED) === "1") return; } catch {}
    jget<AgentsResponseT>("/api/agents")
      .then((r) => {
        const unconnected = r.agents.filter((a) => !a.connected);
        if (unconnected.length) { setPending(unconnected); setOpen(true); }
      })
      .catch(() => {});
  }, [ready]);

  if (!open || !pending || pending.length === 0) return null;
  const names = pending.map((a) => a.label).join(" & ");
  const close = () => { setOpen(false); try { localStorage.setItem(NUDGE_DISMISSED, "1"); } catch {} };

  return (
    <Modal
      title="Add another agent"
      sub="Run tasks on more than one coding agent — entirely optional."
      onClose={close}
      width={480}
      footer={<>
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={close}>Not now</button>
        <button className="btn btn-accent" onClick={() => { close(); onConnect(); }}>
          {Icon.bolt()} Connect {pending.length === 1 ? pending[0].label : "an agent"}
        </button>
      </>}
    >
      <p style={{ margin: 0, color: "var(--ink-2)", lineHeight: 1.55 }}>
        Claude is connected and runs the app&apos;s own jobs. Connect {names} with your subscription
        login (no API key needed) to also pick {pending.length > 1 ? "them" : "it"} for a task. You
        can always do this later from <strong>Settings → Agents</strong>.
      </p>
    </Modal>
  );
}

// Generic "connect an agent" card, driven entirely by the agent-scoped auth
// routes (/api/agents/[id]/{login,login/code,verify,api-key}) and the driver's
// capabilities from GET /api/agents. One component serves every agent — Claude's
// paste-a-code OAuth and Codex's device-code flow both fit — so agent #3 is a
// registry entry with no new UI. Used by the Settings "Agents" section and the
// post-setup "connect another agent" nudge. (The first-run wizard keeps its own
// Claude-specific step so it can drive the onboarding funnel.)
export function AgentConnect({
  agent,
  onConnected,
  compact,
}: {
  agent: AgentInfoT;
  onConnected?: () => void;
  compact?: boolean;
}) {
  const canApiKey = !!agent.capabilities.apiKeyHint;
  const [mode, setMode] = useState<"subscription" | "api_key">(agent.account?.method === "api_key" ? "api_key" : "subscription");
  const [reconnect, setReconnect] = useState(false);

  // Already connected from a prior run — show the state + a reconnect affordance.
  if (agent.connected && !reconnect) {
    return (
      <div className="wiz-connected">
        <span className="wiz-ok">{Icon.check()}</span>
        <div>
          <div className="wiz-ok-t">
            {agent.label} is connected
            {agent.account?.email ? <> as <strong>{agent.account.email}</strong></> : ""}
            {agent.account?.plan ? ` (${agent.account.plan})` : ""}
          </div>
          <div className="hlp" style={{ margin: "3px 0 0" }}>
            <button className="linkbtn" onClick={() => setReconnect(true)}>Reconnect a different account</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {canApiKey && (
        <div className="seg" style={{ maxWidth: 460, marginBottom: 16 }}>
          <button className={mode === "subscription" ? "on" : ""} onClick={() => setMode("subscription")}>
            {Icon.bolt()} Sign in
          </button>
          <button className={mode === "api_key" ? "on" : ""} onClick={() => setMode("api_key")}>
            {Icon.lock()} I have an API key
          </button>
        </div>
      )}
      {mode === "subscription" ? (
        <SubscriptionConnect agent={agent} compact={compact} onConnected={onConnected} />
      ) : (
        <ApiKeyConnect agent={agent} onConnected={onConnected} />
      )}
    </div>
  );
}

// ---------- subscription (device / paste-code) login ----------

function SubscriptionConnect({ agent, onConnected, compact }: { agent: AgentInfoT; onConnected?: () => void; compact?: boolean }) {
  const [login, setLogin] = useState<AgentLoginT | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [showLog, setShowLog] = useState(false);
  const fired = useRef(false);
  const pasteStyle = agent.capabilities.loginStyle === "paste_code";
  const base = `/api/agents/${agent.id}/login`;

  // Rejoin a login already underway (card re-mounted / page reload).
  useEffect(() => {
    jget<AgentLoginT | null>(base)
      .then((l) => { if (l && l.status !== "idle") setLogin(l); })
      .catch(() => {});
  }, [base]);

  const succeed = useCallback(() => {
    if (fired.current) return;
    fired.current = true;
    // Prove it end-to-end before declaring victory (updates the connection record).
    jsend<ClaudeVerifyT>(`/api/agents/${agent.id}/verify`, "POST").catch(() => {}).finally(() => onConnected?.());
  }, [agent.id, onConnected]);

  const start = async () => {
    setBusy(true);
    setCode("");
    fired.current = false;
    try {
      const l = await jsend<AgentLoginT>(base, "POST");
      setLogin(l);
      if (l.status === "success") succeed();
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
      jget<AgentLoginT>(base).then((l) => {
        setLogin(l);
        if (l.status === "success") succeed();
      }).catch(() => {});
    }, 1800);
    return () => clearInterval(t);
  }, [login, base, succeed]);

  const submitCode = async () => {
    if (!code.trim()) return;
    setBusy(true);
    try {
      const l = await jsend<AgentLoginT>(`${base}/code`, "POST", { code: code.trim() });
      setLogin(l);
      if (l.status === "success") succeed();
    } catch (e) {
      setLogin((p) => ({ ...(p as AgentLoginT), status: "error", error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  if (login?.status === "success") {
    return (
      <div className="wiz-connected">
        <span className="wiz-ok">{Icon.check()}</span>
        <div className="wiz-ok-t">Signed in{login.email ? <> as <strong>{login.email}</strong></> : ""}{login.plan ? ` (${login.plan})` : ""}</div>
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
        <div className="hlp" style={{ marginTop: 0 }}>1. Open this link and sign in to your {agent.label} account:</div>
        <div style={{ display: "flex", gap: 10, margin: "10px 0 16px", flexWrap: "wrap" }}>
          <a className="btn btn-accent" href={login.url ?? undefined} target="_blank" rel="noreferrer">{Icon.bolt()} Open sign-in page</a>
          <button className="btn btn-line" onClick={() => login.url && navigator.clipboard?.writeText(login.url)}>Copy link</button>
        </div>
        {pasteStyle ? (
          <>
            <div className="hlp" style={{ marginTop: 0 }}>2. Paste the code it shows here:</div>
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
          </>
        ) : (
          <>
            <div className="hlp" style={{ marginTop: 0 }}>
              2. When prompted, enter this one-time code{login.code ? "" : " (shown on the sign-in page)"}:
            </div>
            {login.code && <div className="ctx-mono" style={{ fontSize: 20, letterSpacing: 2, margin: "8px 0 2px", fontWeight: 600 }}>{login.code}</div>}
            <div className="wiz-verify" style={{ marginTop: 10 }}><span className="wiz-spin" /> <span>Waiting for you to authorize in the browser…</span></div>
          </>
        )}
        <LogToggle log={login.log} show={showLog} setShow={setShowLog} />
      </div>
    );
  }

  if (login?.status === "starting") {
    return <div className="wiz-verify"><span className="wiz-spin" /> <span>Starting sign-in… preparing your authorization link.</span></div>;
  }

  // idle — initial CTA
  return (
    <div className="field" style={{ maxWidth: 560 }}>
      {!compact && (
        <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
          You&apos;ll get a sign-in link to open in any browser. This stores your login in this workspace and survives restarts — you only do it once.
        </div>
      )}
      <button className="btn btn-accent" disabled={busy} onClick={start} style={{ alignSelf: "flex-start" }}>
        {Icon.bolt()} {busy ? "Starting…" : `Connect ${agent.label} account`}
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

// ---------- API-key path ----------

function ApiKeyConnect({ agent, onConnected }: { agent: AgentInfoT; onConnected?: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hint = agent.capabilities.apiKeyHint ?? "sk-…";

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await jsend(`/api/agents/${agent.id}/api-key`, "POST", { key: key.trim() });
      setSaved(true);
      onConnected?.();
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
          <div className="hlp" style={{ margin: "3px 0 0" }}>Billed per-token. <button className="linkbtn" onClick={() => setSaved(false)}>Replace key</button></div>
        </div>
      </div>
    );
  }

  return (
    <div className="field" style={{ maxWidth: 560 }}>
      <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
        Paste an API key (<code>{hint}</code>). Stored in this workspace only and used to bill {agent.label} usage per-token. Most people should use the subscription sign-in instead.
      </div>
      <div style={{ display: "flex", gap: 8, maxWidth: 520 }}>
        <input type="password" className="ctx-mono" value={key} placeholder={hint} style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && key.trim()) save(); }} />
        <button className="btn btn-accent" disabled={busy || !key.trim()} onClick={save}>{busy ? "Saving…" : "Save key"}</button>
      </div>
      {err && <div className="hlp" style={{ color: "var(--red)", marginTop: 8 }}>⚠ {err}</div>}
    </div>
  );
}
