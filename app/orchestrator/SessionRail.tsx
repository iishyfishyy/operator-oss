"use client";

import { useEffect, useState } from "react";
import { Icon } from "../icons";
import TaskChanges, { type ResolveResult } from "../TaskChanges";
import { fmtTokens } from "./format";
import { clientFeatures } from "@/lib/features";
import type { ServiceInfo } from "@/lib/types";
import type { ProjectRow, TaskRow } from "./types";

type Tab = "diff" | "preview" | "context";
type Session = { n: number; summaryBefore: string | null };

// The live URL a project's dev server is reachable at when no registered
// service reports one — local dev hits the project's stable port directly.
function fallbackUrl(project: ProjectRow): string | null {
  return project.port ? `http://localhost:${project.port}` : null;
}

// Prefer what the service registry reports (on a hosted instance that's the
// public <slug>--<host> URL, exactly what the agent/user should open).
function useLiveUrl(project: ProjectRow): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    setUrl(null);
    fetch(`/api/projects/${project.id}/services`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { services?: ServiceInfo[] } | null) => {
        if (dead || !j?.services) return;
        const withUrl = j.services.filter((s) => s.url);
        const live = withUrl.find((s) => s.status === "running" || s.status === "starting");
        setUrl((live ?? withUrl[0])?.url ?? null);
      })
      .catch(() => { /* fall back below */ });
    return () => { dead = true; };
  }, [project.id]);
  return url ?? fallbackUrl(project);
}

function PreviewPane({ project }: { project: ProjectRow }) {
  const url = useLiveUrl(project);
  const [copied, setCopied] = useState(false);
  const display = url ? url.replace(/^https?:\/\//, "") : "no dev server configured";
  const copy = async () => { if (!url) return; try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* clipboard blocked */ } };
  return (
    <div className="rail-pad">
      <div className="prev-frame">
        <div className="prev-chrome">
          <span className="prev-dots"><i /><i /><i /></span>
          <span className="prev-addr"><span className="prev-live" />{display}</span>
        </div>
        <div className="prev-body">
          <div className="prev-grid" />
          <div className="prev-mock">
            <div className="pm-title">{project.name}</div>
            <div className="pm-bar w60" />
            <div className="pm-bar w80" />
            <div className="pm-rows"><div className="pm-row" /><div className="pm-row" /><div className="pm-row" /></div>
            <div className="pm-cta">Live build</div>
          </div>
        </div>
      </div>
      <div className="prev-actions">
        {url ? <a className="btn btn-line" href={url} target="_blank" rel="noopener noreferrer">{Icon.external()} Open live</a> : <button className="btn btn-line" disabled>{Icon.external()} Open live</button>}
        <button className="btn btn-line" onClick={copy} disabled={!url}>{copied ? Icon.check() : Icon.copy()} {copied ? "Copied" : "Copy link"}</button>
      </div>
      <div className="prev-note">Every project gets a real URL the moment it runs — open it on your phone, send it to a teammate, no deploy step.</div>
    </div>
  );
}

function ContextPane({ task, sessions, running, onClear }: { task: TaskRow; sessions: Session[]; running: boolean; onClear: () => void }) {
  const pct = Math.min(100, Math.max(0, Math.round(task.context_pct)));
  return (
    <div className="rail-pad">
      <div className="ctxw-head">
        <span className="rail-eyebrow">CONTEXT WINDOW</span>
        <span className="ctxw-pct">{pct}% used{task.context_tokens > 0 ? ` · ${fmtTokens(task.context_tokens)} tok` : ""}</span>
      </div>
      <div className="ctxw-meter"><div className="ctxw-fill" style={{ width: `${pct}%` }} /></div>

      <div className="ctxw-timeline">
        {sessions.map((s, i) => {
          const current = i === sessions.length - 1;
          return (
            <div key={s.n} className={`ctxw-node ${current ? "current" : "done"}`}>
              <span className="ctxw-dot" />
              <div className="ctxw-name">Window {s.n} · {current ? "current" : "summarized"}</div>
              <div className="ctxw-desc">
                {current
                  ? "Carried the summary forward and resumed — the mission recorder hands off the thread."
                  : "Condensed to a summary — task lineage preserved across the clear."}
              </div>
            </div>
          );
        })}
      </div>

      <button className="btn btn-line ctxw-clear" onClick={onClear} disabled={running || task.started !== 1}>{Icon.clear()} Clear context now</button>
      <div className="ctxw-foot">Clearing condenses the transcript and seeds a fresh window.</div>
    </div>
  );
}

export function SessionRail({ project, task, sessions, running, onResolveWithAI, onMerged, onClear, onCollapse, onSwitchToChat }: {
  project: ProjectRow; task: TaskRow; sessions: Session[]; running: boolean;
  onResolveWithAI: (taskId: string) => Promise<ResolveResult>;
  onMerged?: () => void;
  onClear: () => void; onCollapse: () => void; onSwitchToChat: () => void;
}) {
  // PREVIEW (project live-URL view) rides on the remote-execution backend, which
  // isn't real yet — keep it behind a flag (default off) so it ships only once
  // the live URL actually works. See lib/features.ts.
  const showPreview = clientFeatures().livePreview;
  const [tab, setTab] = useState<Tab>("diff");
  const Tab = ({ id, label }: { id: Tab; label: string }) => (
    <button className={`rail-tab ${tab === id ? "on" : ""}`} onClick={() => setTab(id)}>{label}</button>
  );
  return (
    <aside className="sess-rail">
      <div className="rail-tabs">
        <Tab id="diff" label="DIFF" />
        {showPreview && <Tab id="preview" label="PREVIEW" />}
        <Tab id="context" label="CONTEXT" />
        <span style={{ flex: 1 }} />
        <button className="rail-collapse" onClick={onCollapse} title="Hide panel">{Icon.chevRight()}</button>
      </div>
      <div className="rail-scroll">
        {tab === "diff" && (
          <TaskChanges taskId={task.id} running={running} onMerged={onMerged} onResolveWithAI={async (id) => {
            const res = await onResolveWithAI(id);
            if (res.ok && !res.merged) onSwitchToChat();
            return res;
          }} />
        )}
        {tab === "preview" && showPreview && <PreviewPane project={project} />}
        {tab === "context" && <ContextPane task={task} sessions={sessions} running={running} onClear={onClear} />}
      </div>
    </aside>
  );
}
