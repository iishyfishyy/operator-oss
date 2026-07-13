"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { jget, jsend } from "./api";
import { LoadNote, Skel, ErrNote } from "./shared";
import type { GhStatusT, GhLoginT, GhRepoT } from "./types";

// The "Clone from GitHub" pane of the new-project modal: shows the guided
// connect step when the workspace isn't logged in, the user's repo list when
// it is, and always accepts a pasted URL as the escape hatch.
export function GitHubClonePicker({ value, onChange }: { value: string; onChange: (spec: string, shortName?: string) => void }) {
  const [status, setStatus] = useState<GhStatusT | null>(null);
  const refresh = useCallback(() => {
    jget<GhStatusT>("/api/github/status")
      .then(setStatus)
      .catch(() => setStatus({ installed: false, authenticated: false, login: null }));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  if (!status) return <LoadNote style={{ padding: 0, marginBottom: 14 }}>Checking GitHub connection…</LoadNote>;
  return (
    <>
      {status.authenticated ? (
        <GhRepoList selected={value} onPick={(r) => onChange(r, r.split("/").pop())} />
      ) : status.installed ? (
        <GitHubConnect onConnected={refresh} />
      ) : (
        <div className="hlp" style={{ marginBottom: 14 }}>
          The GitHub CLI (<code>gh</code>) isn&apos;t available in this workspace, so only public repos can be cloned — paste a URL below.
        </div>
      )}
      <div className="field">
        <div className="lab">Repository {status.authenticated && <span className="opt">— or paste any URL</span>}</div>
        <input type="text" className="ctx-mono" value={value} placeholder="owner/repo or https://github.com/owner/repo"
          onChange={(e) => onChange(e.target.value)} />
      </div>
    </>
  );
}

// Guided `gh auth login` device flow: one click starts it, the one-time code +
// verification URL appear right here (no terminal scrollback), and we poll
// until GitHub confirms. The session lives server-side, so closing the modal
// mid-login and reopening resumes the same code.
export function GitHubConnect({ onConnected }: { onConnected: () => void }) {
  const [login, setLogin] = useState<GhLoginT | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const done = useRef(false);

  // Rejoin a login that's already underway (e.g. the modal was closed mid-flow).
  useEffect(() => {
    jget<GhLoginT>("/api/github/login").then((l) => { if (l.status !== "idle") setLogin(l); }).catch(() => {});
  }, []);

  const start = async () => {
    setBusy(true);
    try {
      setLogin(await jsend<GhLoginT>("/api/github/login", "POST"));
    } catch (e) {
      setLogin({ status: "error", code: null, url: null, user: null, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    await jsend("/api/github/login", "DELETE").catch(() => {});
    setLogin(null);
  };

  // Poll while gh waits for the user to authorize on github.com.
  useEffect(() => {
    if (!login || (login.status !== "starting" && login.status !== "awaiting")) return;
    const t = setInterval(() => {
      jget<GhLoginT>("/api/github/login").then((l) => {
        setLogin(l);
        if (l.status === "success" && !done.current) { done.current = true; onConnected(); }
      }).catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [login, onConnected]);

  const copyCode = () => {
    if (!login?.code) return;
    navigator.clipboard?.writeText(login.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  if (!login || login.status === "idle") {
    return (
      <div className="field">
        <div className="hlp" style={{ marginTop: 0, marginBottom: 8 }}>
          Connect GitHub once to pick from your repos — including private ones. The sign-in is stored in this workspace and survives restarts.
        </div>
        <button className="btn btn-line" disabled={busy} onClick={start} style={{ alignSelf: "flex-start" }}>
          {Icon.github()} {busy ? "Starting…" : "Connect GitHub"}
        </button>
      </div>
    );
  }
  if (login.status === "starting") return <LoadNote style={{ padding: 0, marginBottom: 14 }}>Starting GitHub sign-in…</LoadNote>;
  if (login.status === "awaiting") {
    return (
      <div className="field" style={{ border: "1px solid var(--line-strong)", borderRadius: "var(--r)", background: "var(--raise)", padding: "14px 16px" }}>
        <div className="hlp" style={{ marginTop: 0 }}>Enter this one-time code on GitHub to connect:</div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "10px 0" }}>
          <button onClick={copyCode} title="Click to copy"
            style={{ fontFamily: "var(--mono)", fontSize: 24, fontWeight: 700, letterSpacing: ".12em", color: "var(--ink)", background: "none", border: "1px dashed var(--line-strong)", borderRadius: 8, padding: "6px 14px", cursor: "pointer" }}>
            {login.code}
          </button>
          <span className="hlp" style={{ margin: 0 }}>{copied ? "Copied!" : "click to copy"}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <a className="btn btn-accent" href={login.url ?? "https://github.com/login/device"} target="_blank" rel="noreferrer">
            {Icon.github()} Open github.com/login/device
          </a>
          <button className="btn btn-ghost" onClick={cancel}>Cancel</button>
        </div>
        <div className="hlp" style={{ marginBottom: 0 }}>Waiting for you to authorize on github.com…</div>
      </div>
    );
  }
  if (login.status === "error") {
    return (
      <div className="field">
        <div className="hlp" style={{ marginTop: 0, color: "var(--red)" }}>⚠ GitHub sign-in failed: {login.error ?? "unknown error"}</div>
        <button className="btn btn-line" onClick={start} style={{ alignSelf: "flex-start" }}>{Icon.restore()} Try again</button>
      </div>
    );
  }
  // success
  return <div className="hlp" style={{ marginBottom: 14 }}>{Icon.check()} Connected as <strong>{login.user}</strong> — loading your repos…</div>;
}

// Searchable list of the user's repos (most recently pushed first).
export function GhRepoList({ selected, onPick }: { selected: string; onPick: (nameWithOwner: string) => void }) {
  const [repos, setRepos] = useState<GhRepoT[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const load = useCallback(() => {
    setError(null);
    setRepos(null);
    jget<GhRepoT[]>("/api/github/repos").then(setRepos).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error) return <ErrNote style={{ marginBottom: 14 }} onRetry={load}>Could not load your repos: {error}</ErrNote>;
  if (!repos) {
    return (
      <div className="field">
        <div className="lab">{Icon.github()} Your repositories</div>
        <div style={{ border: "1px solid var(--line-strong)", borderRadius: "var(--r)", background: "var(--raise)" }} aria-hidden>
          {[46, 60, 38, 52].map((w, i) => (
            <div key={i} className="skel-lrow">
              <Skel w={14} h={14} r={4} />
              <Skel w={`${w}%`} h={11} />
            </div>
          ))}
        </div>
      </div>
    );
  }
  const filtered = repos.filter((r) => r.nameWithOwner.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="field">
      <div className="lab">{Icon.github()} Your repositories</div>
      <input type="text" value={q} placeholder="Search repos…" onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 8 }} />
      <div style={{ border: "1px solid var(--line-strong)", borderRadius: "var(--r)", background: "var(--raise)", maxHeight: 220, overflowY: "auto" }}>
        {filtered.length === 0 && <div className="hlp" style={{ padding: "12px 14px", margin: 0 }}>No repos match.</div>}
        {filtered.map((r) => (
          <button key={r.nameWithOwner} onClick={() => onPick(r.nameWithOwner)} title={r.nameWithOwner}
            style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left", padding: "8px 13px", borderBottom: "1px solid var(--line)", color: "var(--ink)", fontSize: 13, background: selected === r.nameWithOwner ? "var(--accent-soft, rgba(194,96,60,.12))" : "none" }}>
            <span style={{ color: selected === r.nameWithOwner ? "var(--accent)" : "var(--ink-4)", display: "inline-flex" }}>
              {selected === r.nameWithOwner ? Icon.check() : Icon.git()}
            </span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, whiteSpace: "nowrap" }}>{r.nameWithOwner}</span>
            {r.isPrivate && <span style={{ color: "var(--ink-4)", display: "inline-flex" }} title="Private">{Icon.lock()}</span>}
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink-3)", fontSize: 12 }}>{r.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// Settings → GitHub: connection status, the same guided connect flow, and
// disconnect. Useful for checking the login survived a workspace restart.
export function GitHubSettings() {
  const [status, setStatus] = useState<GhStatusT | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = useCallback(() => {
    jget<GhStatusT>("/api/github/status")
      .then(setStatus)
      .catch(() => setStatus({ installed: false, authenticated: false, login: null }));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const disconnect = async () => {
    setErr(null);
    try {
      await jsend("/api/github/logout", "POST");
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (!status) return <LoadNote style={{ padding: 0 }}>Checking GitHub connection…</LoadNote>;
  if (!status.installed) {
    return <div className="hlp">The GitHub CLI (<code>gh</code>) isn&apos;t available in this workspace, so there&apos;s nothing to connect here. Public repos can still be cloned by URL when creating a project.</div>;
  }
  return (
    <div className="field">
      <div className="lab">{Icon.github()} GitHub account</div>
      <div className="hlp" style={{ marginTop: 0, marginBottom: 12 }}>
        Used to list and clone your repositories (including private ones) when creating a project, and for <code>git push/pull</code> in tasks and the terminal. The sign-in is stored in this workspace and survives restarts.
      </div>
      {status.authenticated ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "var(--ink)" }}>
            {Icon.check()} Connected as <strong>{status.login ?? "unknown"}</strong>
          </span>
          <button className="btn btn-line btn-sm" onClick={disconnect}>{Icon.x()} Disconnect</button>
        </div>
      ) : (
        <GitHubConnect onConnected={refresh} />
      )}
      {err && <ErrNote style={{ marginTop: 10 }}>{err}</ErrNote>}
    </div>
  );
}
