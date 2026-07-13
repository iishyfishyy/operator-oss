"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import { jget } from "./api";
import type { PaletteTaskRow, ProjectRow } from "./types";
import { StatusDot } from "./shared";

// One executable command surfaced by the palette. Callers pass only the
// commands that currently make sense (e.g. no "Toggle Terminal" without a
// project selected), so the palette never renders a dead row.
export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string; // right-aligned annotation, e.g. what state the toggle lands on
  keywords?: string; // aliases the fuzzy matcher sees but the row doesn't show
  icon: React.ReactNode;
  run: () => void;
}

// Subsequence fuzzy matcher. Exact-substring hits dominate (earlier = better,
// word-start better still); otherwise every query char must appear in order,
// with bonuses for word starts and consecutive runs and a small gap penalty.
// Returns -Infinity when the query doesn't match at all.
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const t = text.toLowerCase();
  const sub = t.indexOf(q);
  if (sub >= 0) return 1000 - sub + (sub === 0 || /[\s\-_/·.]/.test(t[sub - 1]) ? 50 : 0);
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === " ") continue; // spaces in the query just separate words
    const at = t.indexOf(ch, from);
    if (at < 0) return -Infinity;
    score += 1;
    if (at === prev + 1) score += 2; // consecutive run
    if (at === 0 || /[\s\-_/·.]/.test(t[at - 1])) score += 3; // word start
    score -= Math.min(10, at - from) * 0.05;
    prev = at;
    from = at + 1;
  }
  return score;
}

type Entry =
  | { kind: "project"; project: ProjectRow }
  | { kind: "task"; task: PaletteTaskRow }
  | { kind: "command"; command: PaletteCommand };

const entryKey = (e: Entry) =>
  e.kind === "project" ? `p:${e.project.id}` : e.kind === "task" ? `t:${e.task.id}` : `c:${e.command.id}`;

// With no query the palette is a launcher (a few recent things + every command);
// once you type, it's a search (more room for matches per group).
const EMPTY_LIMITS = { project: 5, task: 6 };
const QUERY_LIMITS = { project: 6, task: 10 };

// The ⌘K command palette: fuzzy search over projects, sessions (tasks across
// ALL active projects) and commands, grouped, keyboard-first. The overlay is a
// centered top sheet over a scrim — Esc or an outside click dismisses, ↑/↓
// move, ⏎ runs the active row. Every color comes from theme vars, so it works
// in both themes for free.
export function CommandPalette({ projects, commands, onPickProject, onPickTask, onClose }: {
  projects: ProjectRow[];
  commands: PaletteCommand[];
  onPickProject: (projectId: string) => void;
  onPickTask: (projectId: string, taskId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [tasks, setTasks] = useState<PaletteTaskRow[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  // Sessions across every project are server state (the client only holds the
  // selected project's tasks) — fetched fresh each open, like NeedsYouMenu.
  useEffect(() => {
    let alive = true;
    jget<{ tasks: PaletteTaskRow[] }>("/api/tasks")
      .then((d) => { if (alive) setTasks(d.tasks); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const { sections, flat } = useMemo(() => {
    const trimmed = query.trim();
    const limits = trimmed ? QUERY_LIMITS : EMPTY_LIMITS;
    const rank = <T,>(items: T[], text: (i: T) => string, limit: number): T[] => {
      if (!trimmed) return items.slice(0, limit);
      return items
        .map((i) => ({ i, s: fuzzyScore(trimmed, text(i)) }))
        .filter((x) => x.s > -Infinity)
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)
        .map((x) => x.i);
    };
    const groups: { title: string; entries: Entry[] }[] = [
      { title: "Projects", entries: rank(projects, (p) => `${p.name} ${p.sub}`, limits.project).map((project) => ({ kind: "project", project })) },
      { title: "Sessions", entries: rank(tasks, (t) => `${t.title} ${t.project_name}`, limits.task).map((task) => ({ kind: "task", task })) },
      { title: "Commands", entries: rank(commands, (c) => `${c.label} ${c.keywords ?? ""}`, commands.length).map((command) => ({ kind: "command", command })) },
    ];
    // Flatten in display order so ↑/↓ walk straight through the groups.
    const flat: Entry[] = groups.flatMap((g) => g.entries);
    let idx = 0;
    const sections = groups
      .filter((g) => g.entries.length > 0)
      .map((g) => ({ title: g.title, rows: g.entries.map((entry) => ({ entry, idx: idx++ })) }));
    return { sections, flat };
  }, [query, projects, tasks, commands]);

  // Typing (or the async session load) reshapes the list — snap the highlight
  // back to the top / into range rather than leaving it on a stale row.
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { if (active >= flat.length) setActive(0); }, [active, flat.length]);

  const run = (e: Entry) => {
    if (e.kind === "project") onPickProject(e.project.id);
    else if (e.kind === "task") onPickTask(e.task.project_id, e.task.id);
    else e.command.run();
    onClose();
  };

  // Keyboard driving. A window *capture* listener so it wins regardless of
  // focus, and so Escape can stopPropagation before any stacked Modal's own
  // bubble-phase Escape handler sees the event (the palette may sit on top).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (flat.length ? (a + 1) % flat.length : 0)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (flat.length ? (a - 1 + flat.length) % flat.length : 0)); return; }
      if (e.key === "Enter") { e.preventDefault(); const cur = flat[active]; if (cur) run(cur); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const row = (entry: Entry, idx: number) => {
    const props = {
      "data-idx": idx,
      className: `pal-row${idx === active ? " on" : ""}`,
      onMouseEnter: () => setActive(idx),
      onClick: () => run(entry),
    };
    if (entry.kind === "project") {
      const p = entry.project;
      return (
        <button key={entryKey(entry)} {...props}>
          <span className="pr-chip" style={{ background: p.color }}>{(p.icon || p.name[0] || "?").toUpperCase()}</span>
          <span className="pr-title">{p.name}</span>
          {p.sub && <span className="pr-sub">{p.sub}</span>}
          {idx === active && <span className="pr-hint">⏎ open</span>}
        </button>
      );
    }
    if (entry.kind === "task") {
      const t = entry.task;
      return (
        <button key={entryKey(entry)} {...props}>
          <span className="pr-chip" style={{ background: t.project_color }} title={t.project_name}>
            {(t.project_icon || t.project_name[0] || "?").toUpperCase()}
          </span>
          <StatusDot status={t.status} running={t.running === 1} awaiting={t.awaiting_input === 1 && t.running !== 1} />
          <span className="pr-title">{t.title}</span>
          <span className="pr-sub">{t.project_name}</span>
          {idx === active && <span className="pr-hint">⏎ open</span>}
        </button>
      );
    }
    const c = entry.command;
    return (
      <button key={entryKey(entry)} {...props}>
        <span className="pr-ic">{c.icon}</span>
        <span className="pr-title">{c.label}</span>
        {c.hint && <span className="pr-sub">{c.hint}</span>}
        {idx === active && <span className="pr-hint">⏎ run</span>}
      </button>
    );
  };

  return (
    <div className="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette">
        <div className="palette-input">
          <span className="p-ic">{Icon.search()}</span>
          <input
            autoFocus
            value={query}
            placeholder="Jump to a project or session, or run a command…"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="palette-kbd">esc</span>
        </div>
        <div className="palette-list" ref={listRef}>
          {flat.length === 0 && <div className="palette-empty">Nothing matches “{query.trim()}”.</div>}
          {sections.map((sec) => (
            <div key={sec.title}>
              <div className="pop-sec">{sec.title}</div>
              {sec.rows.map((r) => row(r.entry, r.idx))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
