"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Skel, ErrNote } from "./orchestrator/shared";

interface DiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
  truncated?: boolean;
}
interface DiffResp {
  isolated: boolean;
  reason?: string;
  branch?: string;
  baseLabel?: string;
  merged_at?: number;
  alreadyMerged?: boolean;
  files: DiffFile[];
  isDirty: boolean;
  ahead: number;
  error?: string;
  mergeInProgress?: boolean; // a conflict resolution is staged, awaiting accept/discard
  unresolved?: string[]; // files still flagged unmerged
}
interface MergeResp {
  ok: boolean;
  targetBranch: string;
  committed: boolean;
  alreadyMerged?: boolean;
  conflicts?: string[];
  error?: string;
}
// Returned by the AI-resolution callback wired from the parent (it runs the
// /prepare step + streams the resolution turn into the transcript).
export interface ResolveResult {
  ok: boolean;
  merged?: boolean; // trial merge was clean and landed immediately
  error?: string;
  conflicts?: string[];
  binaryConflicts?: string[];
}

const STATUS_LABEL: Record<string, string> = { A: "added", M: "modified", D: "deleted", R: "renamed", "?": "new" };

// The merge routes always answer JSON, but a layer above them can still hand
// back HTML (a tunnel 502, a request killed at maxDuration) — parse defensively
// so the banner shows the HTTP status, not JSON.parse's "Unexpected token '<'".
const mergeJson = (r: Response): Promise<MergeResp> =>
  r.json().catch(() => ({ ok: false, targetBranch: "", committed: false, error: `merge request failed (HTTP ${r.status})` }));

// Last fetched diff per task, module-level so it survives unmounts. The rail
// remounts this component on every collapse/expand, DIFF↔CONTEXT tab switch,
// and chat/changes toggle — without a cache each of those pays a fresh
// diff-endpoint round trip behind a skeleton. With it, reopening renders the
// previous diff instantly and revalidates in the background.
const diffCache = new Map<string, DiffResp>();

// Strip the file-metadata preamble (diff --git / index / --- / +++) and return
// just the hunk lines, the way GitHub shows them.
function hunkLines(patch: string): string[] {
  const lines = patch.split("\n");
  const i = lines.findIndex((l) => l.startsWith("@@"));
  return i >= 0 ? lines.slice(i) : [];
}
function lineClass(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "del";
  return "";
}

// Files past this many hunk lines start collapsed: a diff with many files near
// the per-file patch cap would otherwise mount tens of thousands of line divs
// in one commit and jank the main thread when the rail opens.
const COLLAPSE_LINES = 400;

// One file section. Memoized so the scroll tracker's setActive (which fires on
// every scroll frame) re-renders only the overview list, not every hunk line
// of every file.
const FileDiff = memo(function FileDiff({
  file: f,
  userToggled,
  onToggle,
  refs,
}: {
  file: DiffFile;
  userToggled: boolean; // user flipped this file away from its default state
  onToggle: (path: string) => void;
  refs: { current: Record<string, HTMLDivElement | null> };
}) {
  const lines = useMemo(() => (f.binary ? [] : hunkLines(f.patch)), [f]);
  const big = lines.length > COLLAPSE_LINES;
  const isCollapsed = userToggled ? !big : big;
  // Accurate placeholder height for content-visibility while the section is
  // offscreen-unrendered (header ≈34px, hunk lines 12px × 1.55 line-height),
  // so offsetTop-based jump/scroll-spy stay truthful. `auto` pins the real
  // size once rendered.
  const est = Math.round(34 + (isCollapsed ? 38 : Math.max(1, lines.length) * 18.6));
  return (
    <div
      className="tc-file"
      style={{ containIntrinsicSize: `auto ${est}px` }}
      ref={(el) => { refs.current[f.path] = el; }}
    >
      <button className="tc-fhead" onClick={() => onToggle(f.path)}>
        <span className={`tc-chev ${isCollapsed ? "" : "open"}`}>▸</span>
        <span className={`tc-st s-${f.status === "?" ? "new" : f.status}`}>{f.status}</span>
        <span className="tc-fpath">{f.path}</span>
        <span className="tc-cnt">
          <b className="add">+{f.additions}</b> <b className="del">−{f.deletions}</b>
        </span>
      </button>
      {isCollapsed ? (
        // A big file collapsed by default still needs to say why it's empty.
        big && (
          <button className="tc-bigdiff" onClick={() => onToggle(f.path)}>
            Large diff ({lines.length.toLocaleString()} lines) — click to expand
          </button>
        )
      ) : (
        <div className="tc-hunks">
          {f.binary ? (
            <div className="tc-empty">Binary file — not shown</div>
          ) : lines.length === 0 ? (
            <div className="tc-empty">No textual changes (mode or rename).</div>
          ) : (
            lines.map((ln, i) => (
              <div key={i} className={`dl ${lineClass(ln)}`}>
                {ln || " "}
              </div>
            ))
          )}
          {f.truncated && <div className="tc-empty">… file diff truncated</div>}
        </div>
      )}
    </div>
  );
});

export default function TaskChanges({
  taskId,
  running,
  prUrl,
  onMerged,
  onPrCreated,
  onResolveWithAI,
}: {
  taskId: string;
  running?: boolean;
  prUrl?: string; // GitHub PR already opened from this branch ("" / undefined = none)
  onMerged?: () => void;
  onPrCreated?: (url: string) => void;
  onResolveWithAI?: (taskId: string) => Promise<ResolveResult>;
}) {
  const [data, setData] = useState<DiffResp | null>(() => diffCache.get(taskId) ?? null);
  const [loading, setLoading] = useState(true);
  const [merging, setMerging] = useState(false);
  const [prBusy, setPrBusy] = useState(false);
  const [prErr, setPrErr] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [binaryConflicts, setBinaryConflicts] = useState<string[]>([]);
  const [mergeRes, setMergeRes] = useState<MergeResp | null>(null);
  const [active, setActive] = useState<string | null>(null);
  // Paths the user flipped away from their default state (expanded normally,
  // collapsed for big files) — override semantics so a background revalidate
  // doesn't reset the user's choices.
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const secRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/tasks/${taskId}/diff`, { cache: "no-store" });
      const j: DiffResp = await r.json();
      if (!j.error) diffCache.set(taskId, j); // errors are worth retrying, not replaying
      setData(j);
    } catch (e) {
      setData({ isolated: false, files: [], isDirty: false, ahead: 0, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    setMergeRes(null);
    setPrErr(null);
    setToggled(new Set());
    setManualOpen(false);
    setBinaryConflicts([]);
    // Task switched without a remount: show the new task's cached diff (or the
    // skeleton), never the previous task's stale files, while we revalidate.
    setData(diffCache.get(taskId) ?? null);
    load();
  }, [taskId, load]);

  // The diff moves while the agent works — refetch when a turn finishes so a
  // just-written change appears without a manual Refresh (same trigger the
  // SyncBanner uses). Only on the running→idle transition; mount already loads.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) load();
    wasRunning.current = running;
  }, [running, load]);

  // Track which file is at the top of the scroll area to highlight it in the list.
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc || !data?.files?.length) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const top = sc.scrollTop + 16;
        let cur = data.files[0]?.path ?? null;
        for (const f of data.files) {
          const el = secRefs.current[f.path];
          if (el && el.offsetTop <= top) cur = f.path;
        }
        setActive(cur);
      });
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      sc.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [data]);

  const jump = (path: string) => {
    const el = secRefs.current[path];
    const sc = scrollRef.current;
    if (!el || !sc) return;
    setActive(path);
    // content-visibility placeholders make offsetTop an estimate until the
    // sections near the target actually render, and that rendering lags the
    // scroll by a frame or two — so instead of one smooth scroll to a
    // coordinate that goes stale mid-flight, jump instantly and keep
    // re-targeting for a few frames while the layout settles.
    let frames = 0;
    const settle = () => {
      const top = Math.max(0, el.offsetTop - 4);
      if (Math.abs(sc.scrollTop - top) > 1) sc.scrollTop = top;
      if (++frames < 12) requestAnimationFrame(settle);
    };
    settle();
  };
  const toggle = useCallback(
    (path: string) =>
      setToggled((s) => {
        const n = new Set(s);
        n.has(path) ? n.delete(path) : n.add(path);
        return n;
      }),
    []
  );

  const doMerge = async () => {
    setMerging(true);
    setMergeRes(null);
    try {
      const r = await fetch(`/api/tasks/${taskId}/merge`, { method: "POST" });
      const res = await mergeJson(r);
      setMergeRes(res);
      if (res.ok) {
        onMerged?.();
        load();
      }
    } catch (e) {
      setMergeRes({ ok: false, targetBranch: "", committed: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setMerging(false);
    }
  };

  // Review-on-GitHub path: push the branch + open (or update) a PR. The server
  // commits any dirty work first and is idempotent, so a second click on an
  // already-open PR just pushes the new commits to it.
  const doCreatePr = async () => {
    setPrBusy(true);
    setPrErr(null);
    try {
      const r = await fetch(`/api/tasks/${taskId}/pr`, { method: "POST" });
      const res: { ok?: boolean; url?: string; error?: string } = await r.json();
      if (res.ok && res.url) onPrCreated?.(res.url);
      else setPrErr(res.error || "could not create the PR");
    } catch (e) {
      setPrErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPrBusy(false);
      load(); // the push may have committed dirty work — refresh the diff state
    }
  };

  // Fix with AI: prepare the trial merge + stream a resolution turn (handled by
  // the parent so it shows in the transcript), then reload into review state.
  const doResolveWithAI = async () => {
    if (!onResolveWithAI) return;
    setResolving(true);
    setManualOpen(false);
    setMergeRes(null);
    try {
      const res = await onResolveWithAI(taskId);
      setBinaryConflicts(res.binaryConflicts ?? []);
      if (res.merged) onMerged?.();
      else if (!res.ok)
        setMergeRes({ ok: false, targetBranch: "", committed: false, error: res.error || "AI resolution failed" });
    } finally {
      setResolving(false);
      load(); // reload → mergeInProgress review state (Accept/Discard) or merged
    }
  };

  // Accept a resolution: commit + land the (now clean) branch into the base.
  const doComplete = async () => {
    setMerging(true);
    try {
      const r = await fetch(`/api/tasks/${taskId}/merge/complete`, { method: "POST" });
      const res = await mergeJson(r);
      setMergeRes(res);
      if (res.ok) onMerged?.();
    } catch (e) {
      setMergeRes({ ok: false, targetBranch: "", committed: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setMerging(false);
      load();
    }
  };

  // Discard a resolution: abort the trial merge, back to a clean worktree.
  const doAbort = async () => {
    setMerging(true);
    try {
      await fetch(`/api/tasks/${taskId}/merge/abort`, { method: "POST" });
      setMergeRes(null);
      setBinaryConflicts([]);
    } finally {
      setMerging(false);
      load();
    }
  };

  if (loading && !data) {
    // Diffing shells out to git — sketch the toolbar + file list so the tab
    // reads "computing the diff", not "empty".
    return (
      <div className="tc-root" aria-hidden>
        <div className="tc-bar">
          <Skel w={150} h={13} />
          <Skel w={70} h={11} />
          <span className="tc-spacer" />
          <Skel w={130} h={26} r="var(--r-sm)" />
        </div>
        <div className="tc-scroll">
          <div className="tc-list">
            {[62, 44, 54].map((w, i) => (
              <div key={i} className="skel-lrow">
                <Skel w={13} h={13} r={4} />
                <Skel w={`${w}%`} h={11} />
                <span style={{ flex: 1 }} />
                <Skel w={46} h={10} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }
  if (!data) return <div className="tc-note">No data.</div>;
  if (data.error) return <div className="tc-note"><ErrNote onRetry={load}>{data.error}</ErrNote></div>;
  if (!data.isolated) return <div className="tc-note">{data.reason || "No isolated branch for this task."}</div>;

  const merged = !!data.merged_at || !!data.alreadyMerged;
  const totalAdd = data.files.reduce((n, f) => n + f.additions, 0);
  const totalDel = data.files.reduce((n, f) => n + f.deletions, 0);
  const nothing = data.files.length === 0;
  // Something to merge if the branch isn't fully in the base branch yet, or
  // there are uncommitted edits in the worktree. `alreadyMerged` also catches
  // merges done outside the app, so an already-landed branch won't re-offer.
  const pending = !data.alreadyMerged || data.isDirty;
  // A conflict resolution is staged in the worktree, awaiting accept/discard.
  const reviewing = !!data.mergeInProgress;

  return (
    <div className="tc-root">
      <div className="tc-bar">
        <code className="tc-branch">{data.branch}</code>
        <span className="tc-arrow">→ {data.baseLabel}</span>
        {!nothing && (
          <span className="tc-stat">
            <b className="add">+{totalAdd}</b> <b className="del">−{totalDel}</b>
          </span>
        )}
        {data.isDirty && <span className="tc-dirty">● uncommitted</span>}
        {data.ahead > 0 && <span className="tc-ahead">{data.ahead} commit{data.ahead === 1 ? "" : "s"}</span>}
        <span className="tc-spacer" />
        <button className="tc-btn" onClick={load} disabled={loading || merging || resolving}>
          {loading ? "…" : "Refresh"}
        </button>
        {reviewing ? (
          <>
            <button className="tc-btn" onClick={doAbort} disabled={merging || resolving}>
              Discard
            </button>
            <button className="tc-btn primary" onClick={doComplete} disabled={merging || resolving}>
              {merging ? "Merging…" : "Accept & merge"}
            </button>
          </>
        ) : resolving ? (
          <span className="tc-merged faint">Resolving conflicts with AI…</span>
        ) : (
          <>
            {merged && !pending && <span className="tc-merged">✓ Merged · up to date</span>}
            {prUrl && (
              <a className="tc-btn tc-pr" href={prUrl} target="_blank" rel="noreferrer" title="Open this task's pull request on GitHub">
                PR ↗
              </a>
            )}
            {(data.ahead > 0 || data.isDirty) && (
              <button
                className="tc-btn"
                onClick={doCreatePr}
                disabled={prBusy || merging}
                title={prUrl ? "Push the branch's new commits to the open PR" : "Push the branch to origin and open a GitHub PR"}
              >
                {prBusy ? (prUrl ? "Pushing…" : "Creating PR…") : prUrl ? "Update PR" : "Create PR"}
              </button>
            )}
            {pending && (
              <button className="tc-btn primary" onClick={doMerge} disabled={merging || prBusy}>
                {merging ? "Merging…" : merged ? "Merge new changes" : `Merge to ${data.baseLabel}`}
              </button>
            )}
            {!pending && !merged && !nothing && <span className="tc-merged faint">Up to date</span>}
          </>
        )}
      </div>

      {reviewing && (
        <div className="tc-mergebar review">
          Conflicts resolved — review the merged result below, then <b>Accept &amp; merge</b> or <b>Discard</b>.
          {data.unresolved && data.unresolved.length > 0 && (
            <div className="tc-conflicts">
              {`⚠ ${data.unresolved.length} file(s) still unresolved:\n${data.unresolved.join("\n")}`}
            </div>
          )}
          {binaryConflicts.length > 0 && (
            <div className="tc-conflicts">
              {`Binary conflicts kept the task-branch version — review manually:\n${binaryConflicts.join("\n")}`}
            </div>
          )}
        </div>
      )}

      {prErr && <div className="tc-mergebar bad">⚠ {prErr}</div>}

      {mergeRes && (
        <div className={`tc-mergebar ${mergeRes.ok ? "ok" : "bad"}`}>
          {mergeRes.ok
            ? mergeRes.alreadyMerged
              ? `Already up to date with ${mergeRes.targetBranch}.`
              : `Merged into ${mergeRes.targetBranch}.`
            : `⚠ ${mergeRes.error || "merge failed"}`}
          {mergeRes.conflicts && mergeRes.conflicts.length > 0 && (
            <div className="tc-conflicts">{mergeRes.conflicts.join("\n")}</div>
          )}
          {mergeRes.conflicts && mergeRes.conflicts.length > 0 && !reviewing && (
            <>
              <div className="tc-conflict-actions">
                <button className="tc-btn" onClick={() => setManualOpen((v) => !v)} disabled={resolving || merging}>
                  Resolve manually
                </button>
                {onResolveWithAI && (
                  <button className="tc-btn primary" onClick={doResolveWithAI} disabled={resolving || merging}>
                    {resolving ? "Resolving…" : "Fix with AI"}
                  </button>
                )}
              </div>
              {manualOpen && (
                <div className="tc-manual">
                  Resolve these conflicts yourself in the task&apos;s worktree (use the integrated terminal): merge{" "}
                  <code>{data.baseLabel}</code> into the branch, fix the markers, commit, then click Merge again.
                </div>
              )}
            </>
          )}
        </div>
      )}

      {nothing ? (
        <div className="tc-note">No changes on this branch yet.</div>
      ) : (
        <div className="tc-scroll" ref={scrollRef}>
          {/* overview list — click a file to jump to its diff */}
          <div className="tc-list">
            <div className="tc-list-h">
              {data.files.length} file{data.files.length === 1 ? "" : "s"} changed
            </div>
            {data.files.map((f) => (
              <button key={f.path} className={`tc-frow ${active === f.path ? "on" : ""}`} onClick={() => jump(f.path)} title={f.path}>
                <span className={`tc-st s-${f.status === "?" ? "new" : f.status}`} title={STATUS_LABEL[f.status] || f.status}>
                  {f.status}
                </span>
                <span className="tc-fpath">{f.path}</span>
                {f.binary ? (
                  <span className="tc-bin">bin</span>
                ) : (
                  <span className="tc-cnt">
                    <b className="add">+{f.additions}</b> <b className="del">−{f.deletions}</b>
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* per-file diffs with sticky headers */}
          {data.files.map((f) => (
            <FileDiff key={f.path} file={f} userToggled={toggled.has(f.path)} onToggle={toggle} refs={secRefs} />
          ))}
        </div>
      )}
    </div>
  );
}
