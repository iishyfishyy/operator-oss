"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { jsend } from "./api";
import { LoadNote } from "./shared";
import type { ServiceInfo, ServiceLogLine, ServiceEvent, ServiceStatus, ServiceVisibility } from "@/lib/types";

const LOG_CAP = 1500;

const STATUS_LABEL: Record<ServiceStatus, string> = {
  stopped: "Stopped", starting: "Starting…", running: "Running", exited: "Exited", errored: "Error",
};

// Status dot class — green running, amber starting, red errored, grey otherwise.
function dotClass(s: ServiceStatus): string {
  if (s === "running") return "g";
  if (s === "starting") return "a";
  if (s === "errored") return "r";
  return "x";
}

// A managed service is busy (no controls) only while starting; everything else is
// actionable. An exposed (unmanaged) entry has no process to control.
function ServiceRow({
  svc, selected, onSelect, onAction, onVisibility,
}: {
  svc: ServiceInfo;
  selected: boolean;
  onSelect: () => void;
  onAction: (action: "start" | "stop" | "restart") => void;
  onVisibility: (value: ServiceVisibility) => void;
}) {
  const live = svc.status === "running" || svc.status === "starting";
  const [copied, setCopied] = useState(false);
  // The link worth handing out: the tokened share link when shared, else the URL.
  const copyUrl = svc.shareUrl ?? svc.url;
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!copyUrl) return;
    try {
      await navigator.clipboard.writeText(copyUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard blocked */ }
  };
  // Visibility only matters once the service has a public identity (a slug is
  // assigned at first start/expose; until then there is no URL to gate).
  const showShare = !!svc.slug;
  return (
    <button className={`svc-row${selected ? " on" : ""}`} onClick={onSelect}>
      <span className={`svc-dot ${dotClass(svc.status)}`} />
      <span className="svc-name">{svc.name}</span>
      <span className="svc-status" title={svc.error ?? undefined}>{STATUS_LABEL[svc.status]}{svc.exitCode != null && svc.status !== "running" ? ` (${svc.exitCode})` : ""}</span>
      <span style={{ flex: 1 }} />
      {showShare && (
        <select
          className="svc-vis"
          value={svc.visibility}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onVisibility(e.target.value as ServiceVisibility)}
          title="Who can open this service's URL"
        >
          <option value="private">Private</option>
          <option value="shared">Link</option>
          <option value="public">Public</option>
        </select>
      )}
      {copyUrl && live && (
        <span className="icon-btn" role="button" tabIndex={0} title={copied ? "Copied" : `Copy ${copyUrl}`} onClick={copy}>
          {copied ? Icon.check() : Icon.copy()}
        </span>
      )}
      {svc.url && live && (
        <a className="svc-url" href={svc.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title={`Open ${svc.url}`}>
          :{svc.port}
        </a>
      )}
      {svc.managed && (
        <span className="svc-actions" onClick={(e) => e.stopPropagation()}>
          {live ? (
            <>
              <span className="icon-btn" role="button" tabIndex={0} title="Restart" onClick={() => onAction("restart")}>{Icon.clear()}</span>
              <span className="icon-btn" role="button" tabIndex={0} title="Stop" onClick={() => onAction("stop")}>{Icon.stop()}</span>
            </>
          ) : (
            <span className="icon-btn" role="button" tabIndex={0} title="Start" onClick={() => onAction("start")}>{Icon.play()}</span>
          )}
        </span>
      )}
    </button>
  );
}

function LogView({ lines }: { lines: ServiceLogLine[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // Auto-scroll to the tail unless the user has scrolled up to read history.
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  return (
    <div className="svc-logs" ref={ref} onScroll={onScroll}>
      {lines.length === 0 ? (
        <div className="svc-logs-empty">No output yet.</div>
      ) : (
        lines.map((l, i) => (
          <div key={i} className={`svc-log-line ${l.stream}`}>{l.text || " "}</div>
        ))
      )}
    </div>
  );
}

// Bottom drawer mirroring the terminal drawer: live status + controls + logs for a
// project's managed services, fed by the services SSE stream so it survives a tab
// reload (the processes live in the server, lib/services.ts).
export function ServicesDrawer({
  projectId, hasConfig, visible, height, onClose, onResize,
}: {
  projectId: string;
  hasConfig: boolean;
  visible: boolean;
  height: number;
  onClose: () => void;
  onResize: (h: number) => void;
}) {
  const dragging = useRef(false);
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [logs, setLogs] = useState<Record<string, ServiceLogLine[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  // Resize handle (drag the top edge).
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current) return;
      const h = window.innerHeight - e.clientY;
      onResize(Math.max(140, Math.min(h, Math.round(window.innerHeight * 0.78))));
    };
    const up = () => { dragging.current = false; document.body.style.userSelect = ""; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [onResize]);

  // Live services stream. Reopened per project; each connect re-snapshots.
  useEffect(() => {
    const es = new EventSource(`/api/projects/${projectId}/services/stream`);
    es.onmessage = (e) => {
      let ev: ServiceEvent;
      try { ev = JSON.parse(e.data); } catch { return; }
      if (ev.type === "snapshot") {
        setServices(ev.services);
        setLogs(ev.logs);
        if (!selectedRef.current && ev.services.length) setSelected(ev.services[0].name);
      } else if (ev.type === "status") {
        setServices((prev) => {
          const i = prev.findIndex((s) => s.name === ev.service.name);
          if (i === -1) return [...prev, ev.service];
          const next = prev.slice();
          next[i] = ev.service;
          return next;
        });
        if (!selectedRef.current) setSelected(ev.service.name);
      } else if (ev.type === "log") {
        setLogs((prev) => {
          const cur = prev[ev.name] ?? [];
          const next = cur.length >= LOG_CAP ? [...cur.slice(cur.length - LOG_CAP + 1), ev.line] : [...cur, ev.line];
          return { ...prev, [ev.name]: next };
        });
      } else if (ev.type === "removed") {
        setServices((prev) => prev.filter((s) => s.name !== ev.name));
      }
    };
    return () => es.close();
  }, [projectId]);

  const act = async (name: string, action: "start" | "stop" | "restart" | "visibility", value?: ServiceVisibility) => {
    setErr(null);
    setSelected(name);
    try {
      await jsend(`/api/projects/${projectId}/services`, "POST", { name, action, value });
    } catch (e) {
      let msg = e instanceof Error ? e.message : String(e);
      try { const j = JSON.parse(msg); if (j?.error) msg = j.error; } catch { /* raw */ }
      setErr(msg);
    }
  };

  const current = selected ? logs[selected] ?? [] : [];
  // Supervisor-level failure (port conflict, spawn failure) for the selected
  // service — shown as a banner over the logs, not buried in them.
  const selectedError = selected ? services.find((s) => s.name === selected)?.error ?? null : null;

  return (
    <div className={`term-drawer svc-drawer${visible ? "" : " collapsed"}`} style={visible ? { height } : undefined}>
      <div className="term-resize" onMouseDown={() => { dragging.current = true; document.body.style.userSelect = "none"; }} />
      <div className="term-bar">
        {Icon.sliders()}
        <span className="term-title">Services</span>
        {err && <span className="svc-err">⚠ {err}</span>}
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Hide services (processes keep running)">{Icon.chevDown()}</button>
      </div>
      <div className="svc-body">
        <div className="svc-list">
          {services.length === 0 ? (
            hasConfig ? (
              <LoadNote style={{ padding: "14px 10px" }}>Loading services…</LoadNote>
            ) : (
              <div className="svc-empty">
                No services configured. Add a dev / setup / test command in the project context (⚙).
              </div>
            )
          ) : (
            services.map((s) => (
              <ServiceRow
                key={s.name}
                svc={s}
                selected={selected === s.name}
                onSelect={() => setSelected(s.name)}
                onAction={(a) => act(s.name, a)}
                onVisibility={(v) => act(s.name, "visibility", v)}
              />
            ))
          )}
        </div>
        <div className="svc-log-pane">
          {selectedError && <div className="svc-banner">⚠ {selectedError}</div>}
          <LogView lines={current} />
        </div>
      </div>
    </div>
  );
}
