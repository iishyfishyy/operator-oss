"use client";

// Chain review: review a whole auto-advance chain at once and land it with a
// single merge (lib/chainMerge.ts). ChainCard sits in the tasks column;
// ChainReview replaces the session pane while it's open.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../icons";
import TaskChanges from "../TaskChanges";
import { Markdown } from "../Markdown";
import { StatusDot, Skel, ErrNote } from "./shared";
import { SLABEL, AWAIT_LABEL, type TaskRow } from "./types";
import { chainProgressLabel, stepState, type ChainSummary } from "./chains";
import type { ChainView, ChainStepView, ChainMergeOutcome, ChainPrepareOutcome } from "@/lib/chainMerge";

export function ChainCard({ chain, running, active, onReview }: { chain: ChainSummary; running: Set<string>; active: boolean; onReview: () => void }) {
  const first = chain.steps[0];
  return (
    <div className={`chain-card ${active ? "sel" : ""}`}>
      <div className="chain-top">
        {Icon.git()}
        <span className="chain-title" title={chain.steps.map((s) => s.title).join(" → ")}>{first?.title ?? "Chain"}</span>
        <span className="chain-count">{chain.total} steps</span>
      </div>
      <div className="chain-bar" aria-hidden>
        {chain.steps.map((s) => <span key={s.id} className={`chain-seg st-${stepState(s, running)}`} title={`${(s.chain_pos ?? 0) + 1}. ${s.title}`} />)}
      </div>
      <div className="chain-foot">
        <span className="chain-prog">{chainProgressLabel(chain)}</span>
        <button className="btn btn-accent btn-sm" onClick={onReview}>Review chain</button>
      </div>
    </div>
  );
}

type MergeState = (Partial<ChainMergeOutcome> & { ok: boolean; error?: string; through?: string }) | null;

const postJson = async <T,>(url: string, body: unknown): Promise<T> => {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  // Every chain route answers JSON; a layer above (tunnel 502, maxDuration)
  // may not — surface the status rather than a JSON.parse error.
  return r.json().catch(() => ({ ok: false, error: `request failed (HTTP ${r.status})` }));
};

export function ChainReview({ chainId, tasks, running, onClose, onOpenTask, onRunTurn, onMerged }: {
  chainId: string;
  tasks: TaskRow[]; // the project's rows, kept live by /api/events — a change in any step refetches the view
  running: Set<string>;
  onClose: () => void;
  onOpenTask: (id: string) => void;
  onRunTurn: (taskId: string, text: string) => void; // stream a turn (the AI conflict resolution)
  onMerged: () => void;
}) {
  const [view, setView] = useState<ChainView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"steps" | "combined">("steps");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<MergeState>(null);
  const [manualOpen, setManualOpen] = useState(false);

  // Event-driven refresh: the steps' live status/running/awaiting flags come
  // from the global stream; when any of them moves, re-read the chain view.
  const sig = useMemo(
    () => tasks.filter((t) => t.chain_id === chainId).map((t) => `${t.id}:${t.status}:${running.has(t.id) ? 1 : 0}:${t.awaiting_input}`).join("|"),
    [tasks, chainId, running]
  );

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/chains/${chainId}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setView(j as ChainView);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [chainId]);

  useEffect(() => { void load(); }, [load, sig]);
  useEffect(() => { setRes(null); setOpen(new Set()); setTab("steps"); }, [chainId]);

  const steps = view?.steps ?? [];
  const stepOf = (id?: string | null) => steps.find((s) => s.id === id);
  const target = stepOf(view?.targetId);
  const resolution = view?.resolution ?? null;
  // A staged resolution belongs to the step it was prepared on — retrying
  // "Merge chain" must target that same step to complete it.
  const primaryThrough = resolution?.taskId ?? target?.id;
  const primary = stepOf(primaryThrough);
  const allMerged = steps.length > 0 && steps.every((s) => s.merged);

  const merge = async (through?: string) => {
    setBusy(true);
    setRes(null);
    setManualOpen(false);
    try {
      const out = await postJson<ChainMergeOutcome>(`/api/chains/${chainId}/merge`, { through });
      setRes({ ...out, through });
      if (out.ok) onMerged();
    } catch (e) {
      setRes({ ok: false, error: e instanceof Error ? e.message : String(e), through });
    } finally {
      setBusy(false);
      void load();
    }
  };

  // Conflict path: trial-merge the base into the target step's worktree and
  // stream the resolution prompt as a turn on that step. When it finishes,
  // "Merge chain" completes the staged merge. A clean trial merge lands now.
  const fixWithAI = async (through?: string) => {
    setBusy(true);
    try {
      const prep = await postJson<ChainPrepareOutcome & { prompt?: string; error?: string }>(`/api/chains/${chainId}/merge/prepare`, { through });
      if (prep.merged) {
        setRes({ ...prep.merged, through });
        if (prep.merged.ok) onMerged();
      } else if (!prep.ok) {
        setRes({ ok: false, error: prep.error || "could not prepare the merge", through });
      } else if (prep.prompt) {
        onRunTurn(prep.targetTaskId, prep.prompt);
        setRes(null);
      }
    } catch (e) {
      setRes({ ok: false, error: e instanceof Error ? e.message : String(e), through });
    } finally {
      setBusy(false);
      void load();
    }
  };

  const discardResolution = async () => {
    if (!resolution) return;
    setBusy(true);
    try {
      await fetch(`/api/tasks/${resolution.taskId}/merge/abort`, { method: "POST" });
      setRes(null);
    } finally {
      setBusy(false);
      void load();
    }
  };

  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  if (!view) {
    return (
      <div className="chr-root">
        <div className="chr-head">
          <span className="chr-h1">Chain review</span>
          <span className="tc-spacer" />
          <button className="icon-btn" onClick={onClose} title="Close chain review" aria-label="Close chain review">{Icon.x()}</button>
        </div>
        {err ? <div className="tc-note"><ErrNote onRetry={load}>{err}</ErrNote></div> : (
          <div className="chr-steps" aria-hidden>{[0, 1, 2].map((i) => <div key={i} className="chr-step"><Skel w="60%" h={13} /></div>)}</div>
        )}
      </div>
    );
  }

  const { stats, baseBranch } = view;
  const totalAdd = steps.filter((s) => !s.merged).reduce((n, s) => n + s.additions, 0);
  const totalDel = steps.filter((s) => !s.merged).reduce((n, s) => n + s.deletions, 0);
  const resolutionStep = stepOf(resolution?.taskId);
  const conflictThrough = res?.targetTaskId ?? res?.through;

  return (
    <div className="chr-root">
      <div className="chr-head">
        <span className="chr-h1">Chain review</span>
        <span className="chr-sub">
          {stats.total} steps → <code className="tc-branch">{baseBranch}</code>
        </span>
        <span className="tc-stat"><b className="add">+{totalAdd}</b> <b className="del">−{totalDel}</b></span>
        <span className="tc-spacer" />
        {allMerged ? (
          <span className="tc-merged">✓ Chain merged</span>
        ) : (
          <button
            className="tc-btn primary"
            disabled={busy || !primary || !!primary.mergeBlocker}
            title={primary?.mergeBlocker ?? `Merge every step${primary && primary.id !== steps[steps.length - 1]?.id ? ` through step ${primary.chain_pos + 1}` : ""} into ${baseBranch} with one merge`}
            onClick={() => merge(primaryThrough ?? undefined)}
          >
            {busy ? "Merging…" : resolution ? "Accept & merge chain" : primary && primary.id !== steps[steps.length - 1]?.id ? `Merge through step ${primary.chain_pos + 1}` : "Merge chain"}
          </button>
        )}
        <button className="icon-btn" onClick={onClose} title="Close chain review" aria-label="Close chain review">{Icon.x()}</button>
      </div>
      <div className="chr-progress">
        {stats.finished} in review · {stats.merged} merged
        {stats.running > 0 && ` · ${stats.running} running`}
        {stats.paused > 0 && ` · ${stats.paused} paused`}
        {stats.waiting > 0 && ` · ${stats.waiting} not started`}
      </div>

      {resolution && resolutionStep && (
        <div className="tc-mergebar review">
          A conflict resolution is staged on step {resolutionStep.chain_pos + 1} ({resolutionStep.title}).{" "}
          {resolution.unresolved.length > 0
            ? `${resolution.unresolved.length} file(s) still have conflict markers — let the agent finish, or fix them in the terminal.`
            : "No conflict markers left — review the Combined diff, then Accept & merge chain."}
          {resolution.unresolved.length > 0 && <div className="tc-conflicts">{resolution.unresolved.join("\n")}</div>}
          <div className="tc-conflict-actions">
            <button className="tc-btn" onClick={() => onOpenTask(resolutionStep.id)}>Open session</button>
            <button className="tc-btn" onClick={discardResolution} disabled={busy || resolutionStep.running}>Discard resolution</button>
          </div>
        </div>
      )}

      {res && (
        <div className={`tc-mergebar ${res.ok ? "ok" : "bad"}`}>
          {res.ok
            ? res.alreadyMerged
              ? `Already up to date with ${res.targetBranch}.`
              : `Merged ${res.mergedTaskIds?.length ?? 0} step(s) into ${res.targetBranch}.`
            : `⚠ ${res.error || "merge failed"}`}
          {!res.ok && res.conflicts && res.conflicts.length > 0 && (
            <>
              <div className="tc-conflicts">{res.conflicts.join("\n")}</div>
              <div className="tc-conflict-actions">
                <button className="tc-btn" onClick={() => setManualOpen((v) => !v)} disabled={busy}>Resolve manually</button>
                <button className="tc-btn primary" onClick={() => fixWithAI(conflictThrough)} disabled={busy}>Fix with AI</button>
              </div>
              {manualOpen && (
                <div className="tc-manual">
                  In step {(stepOf(conflictThrough)?.chain_pos ?? 0) + 1}&apos;s worktree (open its session → terminal): merge{" "}
                  <code>{baseBranch}</code> into the branch, fix the markers, commit, then click Merge chain again.
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div className="chr-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "steps"} className={tab === "steps" ? "on" : ""} onClick={() => setTab("steps")}>Steps</button>
        <button role="tab" aria-selected={tab === "combined"} className={tab === "combined" ? "on" : ""} onClick={() => setTab("combined")}>Combined</button>
      </div>

      {tab === "combined" ? (
        <div className="chr-combined">
          {target ? (
            <TaskChanges key={`combined-${chainId}`} taskId={target.id} diffUrl={`/api/chains/${chainId}/diff`} running={stats.running > 0} readOnly />
          ) : <div className="tc-note">No step of this chain has a branch yet.</div>}
        </div>
      ) : (
        <div className="chr-steps">
          {steps.map((s) => (
            <StepRow
              key={s.id} step={s} isLast={s.id === steps[steps.length - 1]?.id} expanded={open.has(s.id)} busy={busy}
              onToggle={() => toggle(s.id)} onOpen={() => onOpenTask(s.id)} onMergeThrough={() => merge(s.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StepRow({ step: s, isLast, expanded, busy, onToggle, onOpen, onMergeThrough }: {
  step: ChainStepView; isLast: boolean; expanded: boolean; busy: boolean;
  onToggle: () => void; onOpen: () => void; onMergeThrough: () => void;
}) {
  const awaiting = s.status === "in_progress" && s.awaiting_input;
  const label = s.merged ? "Merged" : awaiting ? AWAIT_LABEL : s.running ? "Running" : SLABEL[s.status];
  return (
    <div className={`chr-step ${s.merged ? "merged" : ""}`}>
      <div className="chr-srow">
        <button className="chr-stoggle" onClick={onToggle} aria-expanded={expanded} title={expanded ? "Hide this step's diff" : "Show this step's diff"}>
          <span className={`tc-chev ${expanded ? "open" : ""}`}>▸</span>
          <span className="chr-num">{s.chain_pos + 1}</span>
          <StatusDot status={s.status} running={s.running} awaiting={awaiting} />
          <span className="chr-stitle">{s.title}</span>
        </button>
        <span className={`slabel ${awaiting ? "await" : ""}`}>{label}</span>
        <span className="tc-cnt"><b className="add">+{s.additions}</b> <b className="del">−{s.deletions}</b></span>
        <button className="tc-btn" onClick={onOpen} title="Open this step's session">Open</button>
        {!isLast && !s.merged && (
          <button className="tc-btn" onClick={onMergeThrough} disabled={busy || !!s.mergeBlocker} title={s.mergeBlocker ?? `Merge steps up to and including this one; later steps keep their stack and can merge later`}>
            Merge up to here
          </button>
        )}
      </div>
      {s.step_summary ? (
        <div className="chr-sum"><Markdown>{s.step_summary}</Markdown></div>
      ) : (
        <div className="chr-sum faint">{s.status === "not_started" ? "Not started yet." : "No complete_step summary yet."}</div>
      )}
      {expanded && (
        <div className="chr-diff">
          <TaskChanges taskId={s.id} running={s.running} readOnly />
        </div>
      )}
    </div>
  );
}
