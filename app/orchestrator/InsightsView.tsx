"use client";

// Insights — the usage/analytics dashboard (opened from the top bar; replaces
// the tasks+session columns like Settings does). One fetch pulls per-day facts
// grouped by (day, project, agent) for the widest range plus the same width
// again (GET /api/insights), so every filter change — range, project, agent,
// cache toggle — recomputes locally without touching the server. Ported from
// the "Operator Insights" Claude Design mock; chart styling conventions:
// thin stacked columns with 2px gaps, a crosshair+tooltip hover layer, fixed
// per-entity hues that never repaint when filters change series count.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { agentLabel, capsFor } from "./agents";
import { modelLabel } from "./format";
import type { AgentsBundle } from "./types";

// Mirrors InsightsData in lib/store.ts.
interface Payload {
  projects: { id: string; name: string; color: string; deprecated: number }[];
  usage: { d: string; p: string; a: string; cost: number; inp: number; out: number; cr: number; cw: number }[];
  shipped: { d: string; p: string; a: string; n: number }[];
  merges: { d: string; p: string; a: string; add: number; del: number }[];
  models: { a: string; m: string }[];
}

type Range = "7d" | "30d" | "90d";
interface DayRow {
  key: string;
  date: Date;
  spend: number; inp: number; out: number; cr: number; cw: number; tokens: number;
  tasks: number; add: number; del: number;
  byAgent: Record<string, { spend: number; tokens: number; tasks: number }>;
}

// ---------- formatting ----------
const fmtMoney = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtCompact = (n: number) => {
  n = Math.round(n);
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
};
const fmtDate = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fmtDateLong = (d: Date) => `${WEEKDAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;

// Local-time YYYY-MM-DD — must match the server's `date(..., 'localtime')`
// bucketing (single-user local-first: the server's clock is the user's clock).
function dayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
function daysBack(n: number, endOffset: number): { key: string; date: Date }[] {
  const out: { key: string; date: Date }[] = [];
  const today = new Date();
  today.setHours(12, 0, 0, 0); // noon: immune to DST hour shifts when stepping days
  for (let k = n - 1 + endOffset; k >= endOffset; k--) {
    const d = new Date(today);
    d.setDate(today.getDate() - k);
    out.push({ key: dayKey(d), date: d });
  }
  return out;
}

// Day-resolution "last active" (the facts cube has no finer grain).
function relDay(key: string): string {
  const diff = Math.round((new Date(dayKey(new Date()) + "T12:00").getTime() - new Date(key + "T12:00").getTime()) / 86_400_000);
  if (diff <= 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff < 14) return `${diff}d ago`;
  return `${Math.round(diff / 7)}w ago`;
}

// ---------- color assignment ----------
// Fixed per-entity hues: an agent keeps its color across every chart and filter
// state (color follows the entity, never its rank). Known drivers are pinned;
// any future driver takes the next unused hue in bundle order.
const HUE_POOL = ["var(--blue)", "var(--green)", "var(--amber)", "var(--coral)"];
const HUE_PINS: Record<string, string> = { claude: "var(--blue)", codex: "var(--green)" };
function agentHues(ids: string[]): Record<string, string> {
  const used = new Set(ids.map((id) => HUE_PINS[id]).filter(Boolean));
  const pool = HUE_POOL.filter((h) => !used.has(h));
  const out: Record<string, string> = {};
  let i = 0;
  for (const id of ids) out[id] = HUE_PINS[id] ?? pool[i++ % pool.length];
  return out;
}
const TOKEN_HUES = { inp: "var(--blue)", out: "var(--green)", cw: "var(--amber)", cr: "var(--coral)" } as const;

// ---------- chart primitives (ported from the design) ----------
function Sparkline({ vals, color, w = 120, h = 30 }: { vals: number[]; color: string; w?: number; h?: number }) {
  const mx = Math.max(...vals, 1e-9);
  const mn = Math.min(...vals, 0);
  const span = mx - mn || 1;
  const n = vals.length;
  const pts = vals
    .map((v, i) => {
      const x = n <= 1 ? w / 2 : (i / (n - 1)) * w;
      const y = h - 2 - ((v - mn) / span) * (h - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const area = `M0,${h} L${pts.split(" ").join(" L")} L${w},${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" style={{ display: "block" }}>
      <path d={area} fill={color} opacity={0.1} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" opacity={0.95} />
    </svg>
  );
}

interface TipData { title: string; rows: { label: string; val: string; color?: string; strong?: boolean }[] }
function Tip({ pct, data }: { pct: number; data: TipData }) {
  const anchor =
    pct < 22 ? { left: 0 } : pct > 78 ? { right: 0 } : { left: `${pct}%`, transform: "translateX(-50%)" };
  return (
    <div className="in-tip" style={anchor}>
      <div className="in-tip-t">{data.title}</div>
      {data.rows.map((r, i) => (
        <div key={i} className="in-tip-row">
          {r.color && <span className="in-tip-dot" style={{ background: r.color }} />}
          <span className="in-tip-l">{r.label}</span>
          <span className={`mono in-tip-v${r.strong ? " strong" : ""}`}>{r.val}</span>
        </div>
      ))}
    </div>
  );
}

type Hover = { chart: string | null; i: number | null };
interface DailyProps {
  id: string;
  rows: DayRow[];
  max: number;
  segsFor: (r: DayRow) => { v: number; color: string }[];
  tip: (r: DayRow) => TipData;
  hover: Hover;
  onHover: (h: Hover) => void;
  height?: number;
}

// Stacked daily columns + crosshair/tooltip hover layer. Flex column-reverse
// stacks segments from the baseline; non-hovered days dim while a day is active.
function DailyChart({ id, rows, max, segsFor, tip, hover, onHover, height = 152 }: DailyProps) {
  const n = rows.length;
  const active = hover.chart === id ? hover.i : null;
  return (
    <div style={{ position: "relative", height, width: "100%" }}>
      {[0, 0.25, 0.5, 0.75, 1].map((g) => (
        <div key={g} style={{ position: "absolute", left: 0, right: 0, bottom: `${g * 100}%`, height: 1, background: "var(--grid)" }} />
      ))}
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-end", gap: n > 45 ? 1 : 2, zIndex: 1 }}>
        {rows.map((r, i) => {
          const dim = active != null && active !== i;
          return (
            <div key={r.key} style={{ flex: 1, height: "100%", display: "flex", flexDirection: "column-reverse", opacity: dim ? 0.4 : 1, transition: "opacity .1s" }}>
              {segsFor(r).map((s, si, arr) => (
                <div
                  key={si}
                  style={{
                    height: `${Math.max(0, (s.v / max) * 100)}%`,
                    minHeight: s.v > 0 ? 1 : 0,
                    background: s.color,
                    borderRadius: si === arr.length - 1 ? "2px 2px 0 0" : 0,
                  }}
                />
              ))}
            </div>
          );
        })}
      </div>
      {active != null && (
        <>
          <div style={{ position: "absolute", top: 0, bottom: 0, left: `${((active + 0.5) / n) * 100}%`, width: 1, background: "var(--line-strong)", zIndex: 2, pointerEvents: "none" }} />
          <Tip pct={((active + 0.5) / n) * 100} data={tip(rows[active])} />
        </>
      )}
      <div style={{ position: "absolute", inset: 0, display: "flex", zIndex: 3 }} onMouseLeave={() => onHover({ chart: null, i: null })}>
        {rows.map((r, i) => (
          <div key={r.key} style={{ flex: 1, cursor: "crosshair" }} onMouseEnter={() => onHover({ chart: id, i })} />
        ))}
      </div>
    </div>
  );
}

// Diverging daily columns around a zero baseline: additions up, deletions down.
function DivergingChart({ id, rows, max, tip, hover, onHover, height = 152 }: Omit<DailyProps, "segsFor" | "max"> & { max: number }) {
  const n = rows.length;
  const active = hover.chart === id ? hover.i : null;
  return (
    <div style={{ position: "relative", height, width: "100%" }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: "50%", height: 1, background: "var(--line-strong)", zIndex: 2 }} />
      <div style={{ position: "absolute", inset: 0, display: "flex", gap: n > 45 ? 1 : 2, zIndex: 1 }}>
        {rows.map((r, i) => {
          const dim = active != null && active !== i;
          return (
            <div key={r.key} style={{ flex: 1, height: "100%", position: "relative", opacity: dim ? 0.4 : 1, transition: "opacity .1s" }}>
              <div style={{ position: "absolute", left: "12%", right: "12%", bottom: "50%", height: `${Math.max(0, (r.add / max) * 49)}%`, minHeight: r.add > 0 ? 1 : 0, background: "var(--green)", borderRadius: "2px 2px 0 0" }} />
              <div style={{ position: "absolute", left: "12%", right: "12%", top: "50%", height: `${Math.max(0, (r.del / max) * 49)}%`, minHeight: r.del > 0 ? 1 : 0, background: "var(--coral)", borderRadius: "0 0 2px 2px" }} />
            </div>
          );
        })}
      </div>
      {active != null && (
        <>
          <div style={{ position: "absolute", top: 0, bottom: 0, left: `${((active + 0.5) / n) * 100}%`, width: 1, background: "var(--line-strong)", zIndex: 2, pointerEvents: "none" }} />
          <Tip pct={((active + 0.5) / n) * 100} data={tip(rows[active])} />
        </>
      )}
      <div style={{ position: "absolute", inset: 0, display: "flex", zIndex: 3 }} onMouseLeave={() => onHover({ chart: null, i: null })}>
        {rows.map((r, i) => (
          <div key={r.key} style={{ flex: 1, cursor: "crosshair" }} onMouseEnter={() => onHover({ chart: id, i })} />
        ))}
      </div>
    </div>
  );
}

// Evenly spaced date labels under a daily chart (5 for long ranges, all for 7d).
function XAxis({ rows }: { rows: DayRow[] }) {
  const nLab = rows.length <= 7 ? rows.length : 5;
  const labs: { left: string; text: string }[] = [];
  for (let j = 0; j < nLab; j++) {
    const idx = Math.round((j / (nLab - 1)) * (rows.length - 1));
    labs.push({ left: `${(((idx + 0.5) / rows.length) * 100).toFixed(2)}%`, text: fmtDate(rows[idx].date) });
  }
  return (
    <div style={{ position: "relative", height: 14 }}>
      {labs.map((x, i) => (
        <span key={i} className="mono in-xlab" style={{ left: x.left }}>{x.text}</span>
      ))}
    </div>
  );
}

function ChartCard({ title, sub, right, children }: { title: string; sub: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="in-card">
      <div className="in-card-h">
        <div>
          <div className="in-card-t">{title}</div>
          <div className="in-card-s">{sub}</div>
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

const LegendSwatch = ({ color, label, dim }: { color: string; label: string; dim?: boolean }) => (
  <span className="in-leg" style={dim ? { color: "var(--ink-4)" } : undefined}>
    <span className="in-leg-dot" style={{ background: color, opacity: dim ? 0.3 : 1 }} />
    {label}
  </span>
);

// ---------- the view ----------
export function InsightsView({ agents, onClose }: { agents: AgentsBundle; onClose: () => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState(false);
  const [range, setRange] = useState<Range>("30d");
  const [project, setProject] = useState<string>("all");
  const [agent, setAgent] = useState<string>("all");
  const [includeCache, setIncludeCache] = useState(false);
  const [menu, setMenu] = useState<"project" | "agent" | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [hover, setHover] = useState<Hover>({ chart: null, i: null });

  useEffect(() => {
    fetch("/api/insights")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setData)
      .catch(() => setError(true));
  }, []);

  // Close any open dropdown on an outside click.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  const N = range === "7d" ? 7 : range === "90d" ? 90 : 30;
  const rangeText = `last ${N} days`;

  const model = useMemo(() => {
    if (!data) return null;
    const matchP = (p: string) => project === "all" || p === project;
    const matchA = (a: string) => agent === "all" || a === agent;

    // Agent ids that ever appear (bundle first for stable hue order, then any
    // id that exists only in historical data, e.g. a removed driver).
    const agentIds = [...agents.agents.map((x) => x.id)];
    for (const r of data.usage) if (!agentIds.includes(r.a)) agentIds.push(r.a);
    const hues = agentHues(agentIds);

    // ---- per-day rows for the current range + totals for the previous one ----
    const blank = (key: string, date: Date): DayRow => ({ key, date, spend: 0, inp: 0, out: 0, cr: 0, cw: 0, tokens: 0, tasks: 0, add: 0, del: 0, byAgent: {} });
    const rows = daysBack(N, 0).map(({ key, date }) => blank(key, date));
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const prevKeys = new Set(daysBack(N, N).map((d) => d.key));
    const prev = { spend: 0, tokens: 0, tasks: 0, add: 0, del: 0 };
    const perAgent = (r: DayRow, a: string) => (r.byAgent[a] ??= { spend: 0, tokens: 0, tasks: 0 });

    for (const u of data.usage) {
      if (!matchP(u.p) || !matchA(u.a)) continue;
      const tokens = u.inp + u.out + u.cr + u.cw;
      const r = byKey.get(u.d);
      if (r) {
        r.spend += u.cost; r.inp += u.inp; r.out += u.out; r.cr += u.cr; r.cw += u.cw; r.tokens += tokens;
        const pa = perAgent(r, u.a);
        pa.spend += u.cost; pa.tokens += tokens;
      } else if (prevKeys.has(u.d)) {
        prev.spend += u.cost; prev.tokens += tokens;
      }
    }
    for (const s of data.shipped) {
      if (!matchP(s.p) || !matchA(s.a)) continue;
      const r = byKey.get(s.d);
      if (r) { r.tasks += s.n; perAgent(r, s.a).tasks += s.n; }
      else if (prevKeys.has(s.d)) prev.tasks += s.n;
    }
    for (const m of data.merges) {
      if (!matchP(m.p) || !matchA(m.a)) continue;
      const r = byKey.get(m.d);
      if (r) { r.add += m.add; r.del += m.del; }
      else if (prevKeys.has(m.d)) { prev.add += m.add; prev.del += m.del; }
    }

    const cur = { spend: 0, tokens: 0, tasks: 0, add: 0, del: 0 };
    for (const r of rows) { cur.spend += r.spend; cur.tokens += r.tokens; cur.tasks += r.tasks; cur.add += r.add; cur.del += r.del; }
    const activeDays = rows.filter((r) => r.spend > 0 || r.tokens > 0 || r.tasks > 0 || r.add > 0 || r.del > 0).length;

    // Agents that actually have usage in the visible rows — drives the spend
    // stack + provider panel, so a single-provider user sees a single series.
    const presentAgents = agentIds.filter((a) => rows.some((r) => r.byAgent[a]));
    const chartAgents = presentAgents.length ? presentAgents : agent === "all" ? [] : [agent];

    // ---- provider panel ----
    const providers = chartAgents.map((a) => {
      let spend = 0, tokens = 0, tasks = 0;
      for (const r of rows) {
        const pa = r.byAgent[a];
        if (pa) { spend += pa.spend; tokens += pa.tokens; tasks += pa.tasks; }
      }
      const models = data.models
        .filter((m) => m.a === a)
        .map((m) => modelLabel(m.m, capsFor(agents, a)) || m.m);
      return { id: a, spend, tokens, tasks, models: [...new Set(models)] };
    });
    const provSpendSum = providers.reduce((s, p) => s + p.spend, 0);

    // ---- projects leaderboard (agent filter applies; project filter doesn't —
    // clicking a row IS the project filter) ----
    const dayIndex = new Map(rows.map((r, i) => [r.key, i]));
    const perProject = new Map<string, { spend: number; tokens: number; tasks: number; add: number; del: number; lastKey: string; spark: number[] }>();
    const proj = (p: string) => {
      let e = perProject.get(p);
      if (!e) { e = { spend: 0, tokens: 0, tasks: 0, add: 0, del: 0, lastKey: "", spark: rows.map(() => 0) }; perProject.set(p, e); }
      return e;
    };
    const touch = (e: { lastKey: string }, d: string) => { if (d > e.lastKey) e.lastKey = d; };
    for (const u of data.usage) {
      if (!matchA(u.a)) continue;
      const i = dayIndex.get(u.d);
      if (i === undefined) continue;
      const e = proj(u.p);
      e.spend += u.cost; e.tokens += u.inp + u.out + u.cr + u.cw; e.spark[i] += u.cost; touch(e, u.d);
    }
    for (const s of data.shipped) {
      if (!matchA(s.a)) continue;
      if (dayIndex.get(s.d) === undefined) continue;
      const e = proj(s.p);
      e.tasks += s.n; touch(e, s.d);
    }
    for (const m of data.merges) {
      if (!matchA(m.a)) continue;
      if (dayIndex.get(m.d) === undefined) continue;
      const e = proj(m.p);
      e.add += m.add; e.del += m.del; touch(e, m.d);
    }
    const projMeta = new Map(data.projects.map((p) => [p.id, p]));
    const projectRows = [...perProject.entries()]
      .map(([id, e]) => ({ id, name: projMeta.get(id)?.name ?? "(deleted project)", color: projMeta.get(id)?.color ?? "var(--ink-4)", ...e }))
      .sort((a, b) => b.spend - a.spend);

    const isEmpty = data.usage.length === 0 && data.shipped.length === 0 && data.merges.length === 0;

    return { rows, cur, prev, activeDays, hues, chartAgents, providers, provSpendSum, projectRows, isEmpty };
  }, [data, N, project, agent, agents]);

  const projName = (id: string) => data?.projects.find((p) => p.id === id)?.name ?? id;

  if (error)
    return (
      <div className="col col-session insights">
        <div className="in-wrap"><div className="in-card-s" style={{ padding: 40, textAlign: "center" }}>Couldn&apos;t load insights — try reloading.</div></div>
      </div>
    );
  if (!data || !model) return <div className="col col-session insights" />;

  const { rows, cur, prev, activeDays, hues, chartAgents, providers, provSpendSum, projectRows, isEmpty } = model;

  const delta = (c: number, p: number): { text: string; arrow: string; color: string } => {
    if (!p || p <= 0) return { text: c > 0 ? "new" : "—", arrow: "", color: "var(--ink-4)" };
    const pct = Math.round(((c - p) / p) * 100);
    if (pct === 0) return { text: "0%", arrow: "", color: "var(--ink-4)" };
    return { text: `${Math.abs(pct)}%`, arrow: pct > 0 ? "▲ " : "▼ ", color: pct > 0 ? "var(--green)" : "var(--coral)" };
  };

  const kpis: { label: string; value: ReactNode; sub: string; spark: ReactNode; d: { text: string; arrow: string; color: string } }[] = [
    { label: "Spend", value: <span className="kpi-big">{fmtMoney(cur.spend)}</span>, sub: "API-equivalent cost", spark: <Sparkline vals={rows.map((r) => r.spend)} color="var(--blue)" />, d: delta(cur.spend, prev.spend) },
    { label: "Tokens used", value: <span className="kpi-big">{fmtCompact(cur.tokens)}</span>, sub: "across all categories", spark: <Sparkline vals={rows.map((r) => r.tokens)} color="var(--green)" />, d: delta(cur.tokens, prev.tokens) },
    { label: "Tasks shipped", value: <span className="kpi-big">{String(Math.round(cur.tasks))}</span>, sub: "merged to base branch", spark: <Sparkline vals={rows.map((r) => r.tasks)} color="var(--blue)" />, d: delta(cur.tasks, prev.tasks) },
    {
      label: "Lines merged",
      value: (
        <span className="kpi-lines">
          <span style={{ color: "var(--green)" }}>+{fmtCompact(cur.add)}</span>
          <span style={{ color: "var(--coral)", fontSize: 18 }}>−{fmtCompact(cur.del)}</span>
        </span>
      ),
      sub: "added / removed on base", spark: <Sparkline vals={rows.map((r) => r.add)} color="var(--green)" />, d: delta(cur.add, prev.add),
    },
    { label: "Active projects", value: <span className="kpi-big">{String(projectRows.length)}</span>, sub: "worked on this period", spark: <Sparkline vals={rows.map((r) => r.spend)} color="var(--ink-3)" />, d: { text: "", arrow: "", color: "var(--ink-4)" } },
  ];

  const spendMax = Math.max(...rows.map((r) => r.spend), 1e-9);
  const tokenMax = Math.max(...rows.map((r) => (includeCache ? r.tokens : r.inp + r.out)), 1e-9);
  const taskMax = Math.max(...rows.map((r) => r.tasks), 1);
  const mergedMax = Math.max(...rows.map((r) => Math.max(r.add, r.del)), 1);
  const tokenCats: { k: "inp" | "out" | "cw" | "cr"; label: string }[] = includeCache
    ? [{ k: "inp", label: "Input" }, { k: "out", label: "Output" }, { k: "cw", label: "Cache write" }, { k: "cr", label: "Cache read" }]
    : [{ k: "inp", label: "Input" }, { k: "out", label: "Output" }];

  const visibleProjects = showAll ? projectRows : projectRows.slice(0, 4);
  const label = (id: string) => agentLabel(agents, id);

  return (
    <div className="col col-session insights">
      <div className="in-wrap">
        {/* header */}
        <div className="in-head">
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <button className="in-back mono" onClick={onClose}>← WORKSPACE</button>
            <div>
              <div className="in-title">Insights</div>
              <div className="in-sub">Your workshop&apos;s odometer — {rangeText}, local to this machine.</div>
            </div>
          </div>
          {!isEmpty && activeDays > 0 && activeDays < 7 && range !== "7d" && (
            <span className="in-sparse mono">{activeDays} DAY{activeDays === 1 ? "" : "S"} OF ACTIVITY SO FAR</span>
          )}
        </div>

        {/* filter row */}
        <div className="in-filters">
          <div className="in-seg">
            {(["7d", "30d", "90d"] as Range[]).map((v) => (
              <button key={v} className={`mono${range === v ? " on" : ""}`} onClick={() => setRange(v)}>{v}</button>
            ))}
          </div>

          <div style={{ position: "relative" }}>
            <button className="in-dd" onClick={(e) => { e.stopPropagation(); setMenu(menu === "project" ? null : "project"); }}>
              <span className="mono in-dd-k">PROJECT</span>
              <span className="in-dd-v">{project === "all" ? "All projects" : projName(project)}</span>
              <span className="in-dd-c">▾</span>
            </button>
            {menu === "project" && (
              <div className="in-menu" onClick={(e) => e.stopPropagation()}>
                {[{ id: "all", name: "All projects" }, ...data.projects.filter((p) => !p.deprecated || perOf(projectRows, p.id))].map((p) => (
                  <button key={p.id} className={project === p.id ? "on" : ""} onClick={() => { setProject(p.id); setMenu(null); }}>
                    <span>{p.name}</span>
                    {p.id !== "all" && <span className="mono in-menu-m">{fmtMoney(perOf(projectRows, p.id)?.spend ?? 0)}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div style={{ position: "relative" }}>
            <button className="in-dd" onClick={(e) => { e.stopPropagation(); setMenu(menu === "agent" ? null : "agent"); }}>
              <span className="mono in-dd-k">AGENT</span>
              <span className="in-dd-v" style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span className="in-leg-dot" style={{ background: agent === "all" ? "var(--ink-3)" : hues[agent], borderRadius: "50%" }} />
                {agent === "all" ? "All agents" : label(agent)}
              </span>
              <span className="in-dd-c">▾</span>
            </button>
            {menu === "agent" && (
              <div className="in-menu" onClick={(e) => e.stopPropagation()}>
                {[{ id: "all" }, ...agents.agents].map((a) => (
                  <button key={a.id} className={agent === a.id ? "on" : ""} onClick={() => { setAgent(a.id); setMenu(null); }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <span className="in-leg-dot" style={{ background: a.id === "all" ? "var(--ink-3)" : hues[a.id], borderRadius: "50%" }} />
                      {a.id === "all" ? "All agents" : label(a.id)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {project !== "all" && (
            <button className="in-clear mono" onClick={() => setProject("all")}>✕ clear project</button>
          )}
        </div>

        {isEmpty ? (
          <div className="in-empty">
            <div className="in-empty-bars">
              {[16, 34, 24, 46, 28].map((h, i) => (<span key={i} style={{ height: h }} />))}
            </div>
            <div style={{ maxWidth: 460 }}>
              <div className="in-empty-t">No activity yet</div>
              <div className="in-empty-s">
                Insights fills in as your agents work. Kick off a session and this view will start tracking
                spend, tokens, tasks shipped, and code merged — all computed locally, nothing leaves this machine.
              </div>
            </div>
            <button className="btn btn-accent" onClick={onClose}>Start a session</button>
            <div className="mono in-empty-f">local-first · single-user · no account required</div>
          </div>
        ) : (
          <>
            {/* KPI row */}
            <div className="in-kpis">
              {kpis.map((k) => (
                <div key={k.label} className="in-kpi">
                  <div className="in-kpi-h">
                    <span className="mono in-kpi-l">{k.label}</span>
                    <span className="mono in-kpi-d" style={{ color: k.d.color }}>{k.d.arrow}{k.d.text}</span>
                  </div>
                  <div style={{ marginTop: 11, marginBottom: 3 }}>{k.value}</div>
                  <div className="in-kpi-s">{k.sub}</div>
                  <div style={{ marginTop: "auto", paddingTop: 12 }}>{k.spark}</div>
                </div>
              ))}
            </div>

            {/* charts */}
            <div className="in-grid">
              <ChartCard
                title="Daily spend" sub="API-equivalent, per day"
                right={chartAgents.length > 1 ? (
                  <div className="in-legend">{chartAgents.map((a) => <LegendSwatch key={a} color={hues[a]} label={label(a)} />)}</div>
                ) : undefined}
              >
                <DailyChart
                  id="spend" rows={rows} max={spendMax} hover={hover} onHover={setHover}
                  segsFor={(r) => chartAgents.map((a) => ({ v: r.byAgent[a]?.spend ?? 0, color: hues[a] }))}
                  tip={(r) => ({
                    title: fmtDateLong(r.date),
                    rows: [
                      ...chartAgents.map((a) => ({ label: label(a), val: fmtMoney(r.byAgent[a]?.spend ?? 0), color: hues[a] })),
                      { label: "Total", val: fmtMoney(r.spend), strong: true },
                    ],
                  })}
                />
                <XAxis rows={rows} />
              </ChartCard>

              <ChartCard
                title="Tokens per day" sub="By category"
                right={
                  <label className="in-switch-l mono">
                    Include cache
                    <button
                      role="switch" aria-checked={includeCache} className={`in-switch${includeCache ? " on" : ""}`}
                      onClick={() => setIncludeCache((v) => !v)}
                    ><span /></button>
                  </label>
                }
              >
                <div className="in-legend" style={{ marginBottom: 4 }}>
                  {([{ k: "inp", label: "Input" }, { k: "out", label: "Output" }, { k: "cr", label: "Cache read" }, { k: "cw", label: "Cache write" }] as const).map((c) => (
                    <LegendSwatch key={c.k} color={TOKEN_HUES[c.k]} label={c.label} dim={!includeCache && c.k !== "inp" && c.k !== "out"} />
                  ))}
                </div>
                <DailyChart
                  id="tokens" rows={rows} max={tokenMax} hover={hover} onHover={setHover}
                  segsFor={(r) => tokenCats.map((c) => ({ v: r[c.k], color: TOKEN_HUES[c.k] }))}
                  tip={(r) => ({
                    title: fmtDateLong(r.date),
                    rows: [
                      ...tokenCats.map((c) => ({ label: c.label, val: fmtCompact(r[c.k]), color: TOKEN_HUES[c.k] })),
                      { label: includeCache ? "Total" : "Fresh total", val: fmtCompact(includeCache ? r.tokens : r.inp + r.out), strong: true },
                    ],
                  })}
                />
                <XAxis rows={rows} />
              </ChartCard>

              <ChartCard
                title="Tasks shipped per day" sub="Merged to base branch"
                right={<span className="mono in-card-n">{Math.round(cur.tasks)} total</span>}
              >
                <DailyChart
                  id="tasks" rows={rows} max={taskMax} hover={hover} onHover={setHover}
                  segsFor={(r) => [{ v: r.tasks, color: "var(--blue)" }]}
                  tip={(r) => ({ title: fmtDateLong(r.date), rows: [{ label: "Tasks shipped", val: String(Math.round(r.tasks)), color: "var(--blue)" }] })}
                />
                <XAxis rows={rows} />
              </ChartCard>

              <ChartCard
                title="Code merged per day" sub="Lines added / removed"
                right={
                  <div className="in-legend">
                    <LegendSwatch color="var(--green)" label="Added" />
                    <LegendSwatch color="var(--coral)" label="Removed" />
                  </div>
                }
              >
                <DivergingChart
                  id="merged" rows={rows} max={mergedMax} hover={hover} onHover={setHover}
                  tip={(r) => ({
                    title: fmtDateLong(r.date),
                    rows: [
                      { label: "Added", val: `+${fmtCompact(r.add)}`, color: "var(--green)" },
                      { label: "Removed", val: `−${fmtCompact(r.del)}`, color: "var(--coral)" },
                    ],
                  })}
                />
                <XAxis rows={rows} />
              </ChartCard>
            </div>

            {/* by provider */}
            <section className="in-card" style={{ marginBottom: 16 }}>
              <div className="in-card-h" style={{ marginBottom: 16 }}>
                <div>
                  <div className="in-card-t">By provider</div>
                  <div className="in-card-s">Share of spend · {rangeText}</div>
                </div>
                <span className="mono in-card-n">{fmtMoney(cur.spend)} total</span>
              </div>
              <div className="in-provbar">
                {providers.map((p) => (
                  <div key={p.id} title={label(p.id)} style={{ width: `${provSpendSum > 0 ? (p.spend / provSpendSum) * 100 : 100 / providers.length}%`, background: hues[p.id] }} />
                ))}
              </div>
              <div className="in-provtable">
                <div className="in-provhead mono">
                  <span>PROVIDER</span><span>SPEND</span><span>TOKENS</span><span>TASKS</span>
                </div>
                {providers.map((p) => (
                  <div key={p.id} className="in-provrow">
                    <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                      <span className="in-leg-dot" style={{ background: hues[p.id] }} />
                      <span style={{ minWidth: 0 }}>
                        <span className="in-provname">{label(p.id)}</span>
                        <span className="mono in-provmodels">{p.models.length ? p.models.join(" · ") : "—"}</span>
                      </span>
                    </span>
                    <span className="mono">{fmtMoney(p.spend)}</span>
                    <span className="mono dim">{fmtCompact(p.tokens)}</span>
                    <span className="mono dim">{String(Math.round(p.tasks))}</span>
                  </div>
                ))}
                {providers.length === 0 && <div className="in-provrow"><span className="in-card-s">No usage in this period.</span></div>}
              </div>
            </section>

            {/* projects leaderboard */}
            <section className="in-card" style={{ padding: 0, overflow: "hidden" }}>
              <div className="in-card-h" style={{ padding: "17px 20px 14px" }}>
                <div>
                  <div className="in-card-t">Projects</div>
                  <div className="in-card-s">Click a row to filter the dashboard</div>
                </div>
                <span className="mono in-card-n">{projectRows.length} active</span>
              </div>
              <div className="in-ptable">
                <div className="in-prow in-phead mono">
                  <span>PROJECT</span><span>SPEND</span><span>TOKENS</span><span>TASKS</span><span>LINES</span><span>LAST ACTIVE</span><span>{N}-DAY ACTIVITY</span>
                </div>
                {visibleProjects.map((p) => (
                  <button
                    key={p.id}
                    className={`in-prow in-pbtn${project === p.id ? " sel" : ""}`}
                    style={project === p.id ? { borderLeftColor: p.color } : undefined}
                    onClick={() => setProject(project === p.id ? "all" : p.id)}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                      <span className="in-leg-dot" style={{ background: p.color, borderRadius: "50%" }} />
                      <span className="in-pname">{p.name}</span>
                    </span>
                    <span className="mono">{fmtMoney(p.spend)}</span>
                    <span className="mono dim">{fmtCompact(p.tokens)}</span>
                    <span className="mono dim">{String(Math.round(p.tasks))}</span>
                    <span className="mono" style={{ fontSize: 12 }}>
                      <span style={{ color: "var(--green)" }}>+{fmtCompact(p.add)}</span>{" "}
                      <span style={{ color: "var(--coral)" }}>−{fmtCompact(p.del)}</span>
                    </span>
                    <span className="mono dim" style={{ fontSize: 11.5 }}>{p.lastKey ? relDay(p.lastKey) : "—"}</span>
                    <span style={{ display: "flex", justifyContent: "flex-end" }}>
                      <span style={{ width: 120 }}><Sparkline vals={p.spark} color={p.color} h={26} /></span>
                    </span>
                  </button>
                ))}
                {projectRows.length === 0 && (
                  <div className="in-prow"><span className="in-card-s" style={{ gridColumn: "1 / -1" }}>No project activity in this period.</span></div>
                )}
                {projectRows.length > 4 && (
                  <button className="in-pmore mono" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? "▲ Show less" : `▾ Show ${projectRows.length - 4} more`}
                  </button>
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

// Row lookup for the project dropdown's spend column.
function perOf<T extends { id: string }>(rows: T[], id: string): T | undefined {
  return rows.find((r) => r.id === id);
}
