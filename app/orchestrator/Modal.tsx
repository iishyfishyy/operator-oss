"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Priority } from "@/lib/types";
import { Icon } from "../icons";
import { jget, jsend } from "./api";
import { SLABEL, type FsListing, type TaskRow } from "./types";
import { StatusDot, Skel, ErrNote } from "./shared";

// Tracks open modals so Escape only dismisses the topmost one when modals stack
// (e.g. the folder picker opened over the project-context editor).
const modalStack: symbol[] = [];

export function Modal({ title, sub, onClose, children, footer, width }: { title: string; sub?: React.ReactNode; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; width?: number }) {
  useEffect(() => {
    const token = Symbol();
    modalStack.push(token);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && modalStack[modalStack.length - 1] === token) onClose(); };
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("keydown", esc);
      const i = modalStack.indexOf(token);
      if (i >= 0) modalStack.splice(i, 1);
    };
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={width ? { width } : undefined}>
        <div className="modal-h">
          <div style={{ flex: 1 }}>
            <div className="m-title">{title}</div>
            {sub && <div className="m-sub" style={{ marginTop: 3 }}>{sub}</div>}
          </div>
          <button className="modal-close" onClick={onClose}>{Icon.x()}</button>
        </div>
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>
  );
}

export function FolderPicker({ initial, onClose, onPick }: { initial?: string; onClose: () => void; onPick: (path: string) => void }) {
  const [data, setData] = useState<FsListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Last path requested — so Retry after a failed listing re-asks for the same
  // folder rather than resetting the whole picker to its initial directory.
  const lastReq = useRef<string | undefined>(undefined);
  const load = useCallback((p?: string) => {
    lastReq.current = p;
    setLoading(true);
    setError(null);
    jget<FsListing>(`/api/fs${p ? `?path=${encodeURIComponent(p)}` : ""}`)
      .then((d) => setData(d))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(initial && initial.trim() ? initial : undefined); }, [load, initial]);

  return (
    <Modal title="Select working directory" sub="pick the folder agents run tasks in" onClose={onClose} width={580}
      footer={<>
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" disabled={!data} onClick={() => data && onPick(data.path)}>{Icon.check()} Use this folder</button>
      </>}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <button className="btn btn-line" disabled={!data?.parent} onClick={() => data?.parent && load(data.parent)} title="Up one level">{Icon.chevDown({ style: { transform: "rotate(180deg)" } })} Up</button>
        <button className="btn btn-line" onClick={() => load(data?.home)} title="Go to home directory">{Icon.folder()} Home</button>
        <div className="ctx-mono" style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: "var(--ink-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={data?.path}>{data?.path ?? "…"}</div>
      </div>
      {error && <ErrNote style={{ marginBottom: 10 }} onRetry={() => load(lastReq.current)}>{error}</ErrNote>}
      <div style={{ border: "1px solid var(--line-strong)", borderRadius: "var(--r)", background: "var(--raise)", maxHeight: 320, overflowY: "auto" }}>
        {loading && [56, 42, 64, 38, 50].map((w, i) => (
          <div key={i} className="skel-lrow">
            <Skel w={15} h={15} r={4} />
            <Skel w={`${w}%`} h={11} />
          </div>
        ))}
        {!loading && data && data.entries.length === 0 && <div className="hlp" style={{ padding: "14px 14px" }}>No subfolders here.</div>}
        {!loading && data && data.entries.map((e) => (
          <button key={e.path} onClick={() => load(e.path)} title={e.path}
            style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left", padding: "9px 13px", borderBottom: "1px solid var(--line)", color: "var(--ink)", fontSize: 13.5 }}>
            <span style={{ color: "var(--accent)", display: "inline-flex" }}>{Icon.folder()}</span>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
            <span style={{ color: "var(--ink-4)", display: "inline-flex" }}>{Icon.chevRight()}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

// "Browse" control for a working-dir field. Tries the OS-native folder chooser
// first (search, new-folder, Finder favorites); silently falls back to the
// in-app FolderPicker when no native dialog is available (non-macOS / headless)
// or the call errors. Cancelling the native dialog is a no-op.
export function BrowseDirButton({ initial, onPick }: { initial?: string; onPick: (p: string) => void }) {
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const browse = useCallback(async () => {
    setBusy(true);
    try {
      const r = await jsend<{ path?: string; canceled?: boolean; unsupported?: boolean }>("/api/fs/pick-dir", "POST", { initial: initial || "" });
      if (r.path) onPick(r.path);
      else if (r.unsupported) setBrowsing(true);
      // canceled → do nothing
    } catch {
      setBrowsing(true); // network/route failure → in-app fallback
    } finally {
      setBusy(false);
    }
  }, [initial, onPick]);
  return (
    <>
      <button type="button" className="btn btn-line" style={{ flex: "none" }} disabled={busy} onClick={browse} title="Browse for a folder">{Icon.folder()} {busy ? "Browse…" : "Browse"}</button>
      {browsing && <FolderPicker initial={initial} onClose={() => setBrowsing(false)} onPick={(p) => { onPick(p); setBrowsing(false); }} />}
    </>
  );
}

export function PrioritySeg({ value, onChange }: { value: Priority; onChange: (p: Priority) => void }) {
  const opts: { key: Priority; label: string; color: string }[] = [
    { key: "lo", label: "Low", color: "var(--ink-4)" },
    { key: "med", label: "Medium", color: "var(--amber)" },
    { key: "hi", label: "High", color: "var(--red)" },
  ];
  return (
    <div className="seg">
      {opts.map((o) => (
        <button key={o.key} className={value === o.key ? "on" : ""} onClick={() => onChange(o.key)}>
          <span className="pdot" style={{ background: o.color }} />{o.label}
        </button>
      ))}
    </div>
  );
}

// "Blocked by" picker — choose the tasks that must reach Done before this one can
// start. Candidates are the other tasks in the project (self excluded by caller).
export function DepPicker({ candidates, value, onChange }: { candidates: TaskRow[]; value: string[]; onChange: (ids: string[]) => void }) {
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="field">
      <div className="lab">Blocked by <span className="opt">— must finish first</span></div>
      {candidates.length === 0 ? (
        <div className="hlp">No other tasks in this project yet.</div>
      ) : (
        <div className="dep-list">
          {candidates.map((c) => (
            <label key={c.id} className={`dep-row ${value.includes(c.id) ? "on" : ""}`}>
              <input type="checkbox" checked={value.includes(c.id)} onChange={() => toggle(c.id)} />
              <StatusDot status={c.status} />
              <span className="dep-title">{c.title}</span>
              <span className="dep-status">{SLABEL[c.status]}</span>
            </label>
          ))}
        </div>
      )}
      <div className="hlp">This task can&apos;t be started until every selected task is marked Done.</div>
    </div>
  );
}
