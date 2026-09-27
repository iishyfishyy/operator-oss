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
import type { ChainView, ChainStepView, ChainFixupView, ChainMergeOutcome, ChainPrepareOutcome } from "@/lib/chainMerge";
import type { RebaseOutcome } from "@/lib/chainActions";

export function ChainCard({ chain, running, active, onReview, onOpenStep, onContinue }: {
  chain: ChainSummary; running: Set<string>; active: boolean; onReview: () => void;
  onOpenStep?: (id: string) => void; // jump to the paused step's session
  onContinue?: (id: string) => void; // resume a paused step (auto-advance picks back up once it calls complete_step)
}) {
  const first = chain.steps[0];
  const paused = chain.pausedStep;
  // An open question is answered in the session, not continued past.
  const canContinue = !!paused && !!onContinue && !running.has(paused.id) && !paused.running && chain.pauseReason !== "Waiting on your answer";
  return (
    <div className={`chain-card ${active ? "sel" : ""}`}>
      <div className="chain-top">
        {Icon.git()}
        <span className="chain-title" title={chain.steps.map((s) => s.title).join(" → ")}>{first?.title ?? "Chain"}</span>
        {chain.awaitsReview && <span className="chain-ready" title="Every step finished — waiting for your review">Ready for review</span>}
        <span className="chain-count">{chain.total} steps</span>
      </div>
      <div className="chain-bar" aria-hidden>
        {chain.steps.map((s) => <span key={s.id} className={`chain-seg st-${stepState(s, running)}`} title={`${(s.chain_pos ?? 0) + 1}. ${s.title}`} />)}
      </div>
      {paused && (
        <div className="chain-pause">
          <span className="chain-pause-txt" title={paused.title}>
            ⏸ Step {(paused.chain_pos ?? 0) + 1} paused — {chain.pauseReason}
          </span>
          {onOpenStep && <button className="chain-link" onClick={() => onOpenStep(paused.id)}>Jump to step</button>}
          {canContinue && <button className="chain-link" onClick={() => onContinue!(paused.id)}>Continue</button>}
        </div>
      )}
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
  const [sendOpen, setSendOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [about, setAbout] = useState("");
  // The outcome of a Send back / Discard / Rebase, shown in the action bar.
  const [note, setNote] = useState<{ ok: boolean; text: string; conflicts?: string[] } | null>(null);

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
  useEffect(() => { setRes(null); setOpen(new Set()); setTab("steps"); setNote(null); setSendOpen(false); }, [chainId]);

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
    setNote(null);
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

  // Send back: the feedback runs as a fix-up turn on the chain's last step
  // (server-side, through the normal resume path). It shows up as a trailing
  // Fix-up entry; when it calls complete_step the chain is back in review.
  const sendBack = async () => {
    setBusy(true);
    setNote(null);
    try {
      const out = await postJson<{ ok: boolean; error?: string; taskId?: string }>(`/api/chains/${chainId}/send-back`, { feedback, about: about || undefined });
      if (out.ok) {
        setFeedback("");
        setAbout("");
        setSendOpen(false);
        setNote({ ok: true, text: `Sent back — a fix-up is running on step ${(stepOf(out.taskId)?.chain_pos ?? 0) + 1}. The chain comes back to review when it finishes.` });
      } else setNote({ ok: false, text: `⚠ ${out.error || "could not send back"}` });
    } finally {
      setBusy(false);
      void load();
    }
  };

  const discardFrom = async (s: ChainStepView) => {
    const doomed = steps.filter((x) => x.chain_pos >= s.chain_pos);
    const msg = `Delete ${doomed.length === 1 ? `step ${s.chain_pos + 1}` : `steps ${s.chain_pos + 1}–${doomed[doomed.length - 1].chain_pos + 1}`} of this chain?\n\n` +
      doomed.map((x) => `${x.chain_pos + 1}. ${x.title}`).join("\n") +
      `\n\nTheir sessions, worktrees and branches are removed for good. Earlier steps stay reviewable and mergeable.`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    setNote(null);
    try {
      const out = await postJson<{ ok: boolean; error?: string; deleted?: string[] }>(`/api/chains/${chainId}/discard`, { from: s.id });
      setNote(out.ok ? { ok: true, text: `Discarded ${out.deleted?.length ?? 0} step(s).` } : { ok: false, text: `⚠ ${out.error || "could not discard"}` });
      if (out.ok && doomed.length === steps.length) onClose();
    } finally {
      setBusy(false);
      void load();
    }
  };

  const rebase = async () => {
    setBusy(true);
    setNote(null);
    try {
      const out = await postJson<RebaseOutcome & { error?: string }>(`/api/chains/${chainId}/rebase`, {});
      setNote(out.ok
        ? { ok: true, text: `Rebased ${out.rebased.length} step(s) onto ${view?.baseBranch ?? "the base branch"}.` }
        : { ok: false, text: `⚠ ${out.error || "rebase failed"}`, conflicts: "conflicts" in out ? out.conflicts : undefined });
    } finally {
      setBusy(false);
      void load();
    }
  };

  const backToReview = async (taskId: string) => {
    setBusy(true);
    try {
      await fetch(`/api/tasks/${taskId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "in_review" }) });
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
        {!allMerged && (
          <button
            className={`tc-btn ${sendOpen ? "on" : ""}`}
            onClick={() => setSendOpen((v) => !v)}
            title={view.sendBackBlocker ?? "Write feedback and run it as a fix-up turn on the last step"}
          >
            Send back
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

      {sendOpen && (
        <div className="chr-send">
          <textarea
            className="chr-send-text" rows={3} value={feedback} autoFocus
            placeholder="What should change? The agent works on the last step's worktree, which has every step's changes."
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && feedback.trim() && !view.sendBackBlocker) void sendBack(); }}
          />
          <div className="chr-send-row">
            <label className="chr-send-about">
              About
              <select value={about} onChange={(e) => setAbout(e.target.value)}>
                <option value="">the whole chain</option>
                {steps.filter((x) => !x.merged).map((x) => <option key={x.id} value={x.id}>step {x.chain_pos + 1}: {x.title}</option>)}
              </select>
            </label>
            <span className="tc-spacer" />
            {view.sendBackBlocker && <span className="chr-send-why">{view.sendBackBlocker}</span>}
            <button className="tc-btn" onClick={() => setSendOpen(false)} disabled={busy}>Cancel</button>
            <button className="tc-btn primary" onClick={sendBack} disabled={busy || !feedback.trim() || !!view.sendBackBlocker}>Send back</button>
          </div>
        </div>
      )}

      {view.warnings.map((w) => <div key={w} className="tc-mergebar review">⚠ {w}</div>)}

      {view.baseMoved && !allMerged && (
        <div className="tc-mergebar review">
          <code>{baseBranch}</code> moved {view.baseMoved.behind} commit{view.baseMoved.behind === 1 ? "" : "s"} ahead since this chain branched.{" "}
          {view.baseMoved.conflicts.length > 0
            ? `Merging would conflict in ${view.baseMoved.conflicts.length} file(s) — merge and use Fix with AI, or try rebasing the stack.`
            : "Rebase the stack onto it to review and test against the latest code before merging."}
          {view.baseMoved.conflicts.length > 0 && <div className="tc-conflicts">{view.baseMoved.conflicts.join("\n")}</div>}
          <div className="tc-conflict-actions">
            <button className="tc-btn" onClick={rebase} disabled={busy || stats.running > 0} title={stats.running > 0 ? "Wait for the running step to finish" : `Replay every unmerged step onto ${baseBranch}; all or nothing`}>
              Rebase stack onto {baseBranch}
            </button>
          </div>
        </div>
      )}

      {note && (
        <div className={`tc-mergebar ${note.ok ? "ok" : "bad"}`}>
          {note.text}
          {note.conflicts && note.conflicts.length > 0 && <div className="tc-conflicts">{note.conflicts.join("\n")}</div>}
        </div>
      )}

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
              onDiscard={() => discardFrom(s)}
            />
          ))}
          {view.fixups.map((f) => (
            <FixupRow key={f.id} fixup={f} busy={busy} onOpen={() => onOpenTask(f.taskId)} onBackToReview={() => backToReview(f.taskId)} />
          ))}
        </div>
      )}
    </div>
  );
}

function StepRow({ step: s, isLast, expanded, busy, onToggle, onOpen, onMergeThrough, onDiscard }: {
  step: ChainStepView; isLast: boolean; expanded: boolean; busy: boolean;
  onToggle: () => void; onOpen: () => void; onMergeThrough: () => void; onDiscard: () => void;
}) {
  const awaiting = s.status === "in_progress" && s.awaiting_input;
  const label = s.merged ? "Merged" : awaiting ? (s.step_pause ? `Paused — ${s.step_pause}` : AWAIT_LABEL) : s.running ? "Running" : SLABEL[s.status];
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
        {!s.merged && (
          <button className="tc-btn danger" onClick={onDiscard} disabled={busy} title={isLast ? "Delete this step (session, worktree and branch)" : "Delete this step and every step after it (sessions, worktrees and branches)"}>
            {isLast ? "Discard" : "Discard from here"}
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

function FixupRow({ fixup: f, busy, onOpen, onBackToReview }: { fixup: ChainFixupView; busy: boolean; onOpen: () => void; onBackToReview: () => void }) {
  const label = f.state === "running" ? "Running" : f.state === "paused" ? AWAIT_LABEL : "Done";
  return (
    <div className="chr-step fixup">
      <div className="chr-srow">
        <span className="chr-fix-tag">Fix-up</span>
        <span className="chr-stitle">
          on step {f.stepPos + 1}{f.aboutPos != null ? ` · about step ${f.aboutPos + 1}${f.aboutTitle ? ` (${f.aboutTitle})` : ""}` : " · whole chain"}
        </span>
        <span className={`slabel ${f.state === "paused" ? "await" : ""}`}>{label}</span>
        <span className="tc-cnt"><b className="add">+{f.additions}</b> <b className="del">−{f.deletions}</b></span>
        <button className="tc-btn" onClick={onOpen} title="Open the session the fix-up runs in">Open</button>
        {f.state === "paused" && (
          <button className="tc-btn" onClick={onBackToReview} disabled={busy} title="You're done with this fix-up — put the chain back in review">Back to review</button>
        )}
      </div>
      <div className="chr-sum chr-fix-fb">“{f.feedback}”</div>
      {f.summary ? <div className="chr-sum"><Markdown>{f.summary}</Markdown></div> : <div className="chr-sum faint">{f.state === "done" ? "Finished without a summary." : "Working on it…"}</div>}
    </div>
  );
}
