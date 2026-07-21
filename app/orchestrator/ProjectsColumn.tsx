"use client";

import { useState } from "react";
import { Icon } from "../icons";
import { fmtCost, relTime } from "./format";
import { SEARCH_MIN, type ProjectRow } from "./types";
import { SearchBar } from "./shared";

export function ProjectsColumn({ projects, deprecated, selId, running, width, onSelect, onNew, onOpenAppearance, onReorder, onRestore, onCollapse, settingsActive, onOpenSettings, mobile }: {
  projects: ProjectRow[]; deprecated: ProjectRow[]; selId: string | null; running: Set<string>; width: number;
  onSelect: (id: string) => void; onNew: () => void; onOpenAppearance: () => void;
  onReorder: (ids: string[]) => void; onRestore: (id: string) => void; onCollapse: () => void;
  settingsActive: boolean; onOpenSettings: () => void; mobile?: boolean;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [showDeprecated, setShowDeprecated] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q ? projects.filter((p) => p.name.toLowerCase().includes(q) || (p.sub ?? "").toLowerCase().includes(q)) : projects;

  const drop = (targetId: string) => {
    if (dragId && dragId !== targetId) {
      const ids = projects.map((p) => p.id);
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(targetId);
      if (from !== -1 && to !== -1) {
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        onReorder(ids);
      }
    }
    setDragId(null);
    setOverId(null);
  };

  return (
    <div className="col col-projects" style={{ flexBasis: width }}>
      <div className="col-head">
        <span className="ch-title">Projects</span>
        <span className="spacer" />
        <button className="icon-btn" title="Appearance" onClick={onOpenAppearance}>{Icon.sliders()}</button>
        <button className="icon-btn" title="New project" onClick={onNew}>{Icon.plus()}</button>
        {!mobile && <button className="icon-btn" title="Hide projects panel" onClick={onCollapse}>{Icon.chevRight({ style: { transform: "rotate(180deg)" } })}</button>}
      </div>
      {projects.length >= SEARCH_MIN && <SearchBar value={query} onChange={setQuery} placeholder="Search projects…" />}
      <div className="scroll">
        <div className="proj-list">
          {shown.map((p) => (
            <button
              key={p.id}
              className={`proj ${p.id === selId ? "sel" : ""} ${dragId === p.id ? "dragging" : ""} ${overId === p.id && dragId && dragId !== p.id ? "drag-over" : ""}`}
              onClick={() => onSelect(p.id)}
              draggable
              onDragStart={(e) => { setDragId(p.id); e.dataTransfer.effectAllowed = "move"; }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragId) setOverId(p.id); }}
              onDrop={(e) => { e.preventDefault(); drop(p.id); }}
              onDragEnd={() => { setDragId(null); setOverId(null); }}
              title="Drag to reorder"
            >
              <div className="pic" style={{ background: p.color }}>
                {p.name[0]}
                {p.awaiting_count > 0 && (
                  <span className="proj-await" title={`${p.awaiting_count} task${p.awaiting_count !== 1 ? "s" : ""} waiting on your input`}>{p.awaiting_count}</span>
                )}
              </div>
              <div className="pmeta">
                <div className="pname">{p.name}</div>
                <div className="psub">
                  {p.task_count} task{p.task_count !== 1 ? "s" : ""}{p.sub ? ` · ${p.sub}` : ""}
                  {p.cost_usd > 0 && <span className="psub-cost" title="Total spend across this project's tasks"> · {fmtCost(p.cost_usd)}</span>}
                </div>
              </div>
              <div className="pcount" title={p.last_activity ? `Last touched ${relTime(p.last_activity)}` : "Never touched"}>
                {p.last_activity ? relTime(p.last_activity) : "never"}
              </div>
            </button>
          ))}
          {q && shown.length === 0 && <div className="search-empty">No projects match “{query.trim()}”.</div>}
          {!q && (
          <button className="proj" style={{ color: "var(--ink-3)" }} onClick={onNew}>
            <div className="pic" style={{ background: "var(--surface-2)", color: "var(--ink-3)", boxShadow: "inset 0 0 0 1px var(--line-2)" }}>{Icon.plus()}</div>
            <div className="pmeta"><div className="pname" style={{ fontWeight: 600, color: "var(--ink-3)" }}>New project</div></div>
          </button>
          )}

          {!q && deprecated.length > 0 && (
            <div className="dep-area">
              <button className="dep-head" onClick={() => setShowDeprecated((s) => !s)} title="Projects you've set aside. Restore one to build on it again.">
                <span className={`dep-chev ${showDeprecated ? "open" : ""}`}>{Icon.chevRight()}</span>
                {Icon.archive()}
                <span className="dep-title">Deprecated</span>
                <span className="dep-count">{deprecated.length}</span>
              </button>
              {showDeprecated && deprecated.map((p) => (
                <div key={p.id} className="proj dep" title={`${p.name} — deprecated. Restore to continue building on it.`}>
                  <div className="pic" style={{ background: p.color }}>{p.name[0]}</div>
                  <div className="pmeta">
                    <div className="pname">{p.name}</div>
                    <div className="psub">{p.task_count} task{p.task_count !== 1 ? "s" : ""}{p.sub ? ` · ${p.sub}` : ""}</div>
                  </div>
                  <button className="icon-btn" title={`Restore ${p.name}`} onClick={() => onRestore(p.id)}>{Icon.restore()}</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="proj-foot">
        <button className={`nav-item${settingsActive ? " active" : ""}`} onClick={onOpenSettings} title="App settings">
          {Icon.gear()} Settings
        </button>
        <div className="user-chip">
          <div className="av">{Icon.bolt()}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="un">Your workspace</div>
            <div className="ue">Max login · no API key</div>
          </div>
        </div>
      </div>
    </div>
  );
}
