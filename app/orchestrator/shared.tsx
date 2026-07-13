"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Priority, Status } from "@/lib/types";
import { Icon } from "../icons";
import { SCLS, SLABEL, AWAIT_LABEL } from "./types";

export function StatusDot({ status, running, awaiting, lg }: { status: Status; running?: boolean; awaiting?: boolean; lg?: boolean }) {
  // Signal language (mission-control): "needs your input" is an alert coral, a
  // *live* working session is blue (both pulse to draw the eye), and an idle
  // status falls back to its base color. Awaiting wins over running — a turn
  // parked on a question is technically live but it's really waiting on you.
  const cls = awaiting ? "c" : running ? "b" : SCLS[status];
  return (
    <span
      className={`sdot ${cls} ${lg ? "lg" : ""} ${awaiting || running ? "pulse" : ""}`}
      title={awaiting ? AWAIT_LABEL : running ? "Live" : SLABEL[status]}
    />
  );
}

export function PriPill({ p }: { p: Priority }) {
  const map: Record<Priority, string> = { hi: "HIGH", med: "MED", lo: "LOW" };
  return <span className={`pri ${p}`}>{map[p]}</span>;
}

export function SearchBar({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="search-bar">
      <span className="search-ic">{Icon.search()}</span>
      <input
        className="search-input" value={value} placeholder={placeholder} spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape" && value) { e.stopPropagation(); onChange(""); } }}
      />
      {value && <button className="search-clear" title="Clear search" onClick={() => onChange("")}>{Icon.x()}</button>}
    </div>
  );
}

export function Avatar({ who }: { who: "user" | "cc" }) {
  return who === "user" ? <span className="av you">A</span> : <span className="av cc">{Icon.bolt()}</span>;
}

// Which agent driver a task runs under (Claude Code / Codex …). Hidden when only
// one agent is available (nothing to disambiguate) so single-agent workspaces
// stay clutter-free. `multi` is passed by the caller from the agents bundle.
export function AgentBadge({ label, multi }: { label: string; multi: boolean }) {
  if (!multi) return null;
  return <span className="agent-badge" title={`Runs on ${label}`}>{label}</span>;
}

// ---- async-state primitives (pair with the .spinner/.load-note/.skel/.err-note
// styles in globals.css) — every panel that fetches uses these, so loading and
// error presentation stays uniform across the app. ----

export function Spinner({ size }: { size?: number }) {
  return <span className="spinner" role="status" aria-label="Loading" style={size ? { width: size, height: size } : undefined} />;
}

// Standard "we're fetching" line: spinner + quiet text. Replaces bare "Loading…".
export function LoadNote({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div className="load-note" style={style}><Spinner size={13} />{children}</div>;
}

// One shimmer bar. Compose a few for card/list/transcript skeletons.
export function Skel({ w, h = 10, r, style }: { w: number | string; h?: number; r?: number | string; style?: React.CSSProperties }) {
  return <span className="skel" aria-hidden style={{ width: w, height: h, ...(r !== undefined ? { borderRadius: r } : null), ...style }} />;
}

// Recoverable-error line: the message plus an inline Retry when the caller can
// simply refetch. Same warm-red voice as transcript system errors.
export function ErrNote({ children, onRetry, retryLabel = "Retry", style }: {
  children: React.ReactNode; onRetry?: () => void; retryLabel?: string; style?: React.CSSProperties;
}) {
  return (
    <div className="err-note" style={style}>
      <span className="err-msg">⚠ {children}</span>
      {onRetry && <button className="btn btn-line btn-sm" onClick={onRetry}>{Icon.restore()} {retryLabel}</button>}
    </div>
  );
}

// A dropdown menu anchored to its trigger. It renders into document.body via a
// portal and positions itself `fixed` from the trigger's measured rect, so it is
// never clipped or pushed off-screen by an ancestor's `overflow` — which is
// exactly what happened on mobile, where the trigger lives inside the
// horizontally-scrolling `.sh-tools` rail (the menu opened ~570px to the right of
// a 390px-wide screen and was unreachable). The trigger is found as the parent of
// an in-place marker span, so call sites don't need to pass a ref.
export function Popover({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const markerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const anchor = markerRef.current?.parentElement; // the position:relative wrapper ≈ the trigger
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth || 200;
    const mh = menu.offsetHeight || 0;
    const vw = window.innerWidth, vh = window.innerHeight;
    // Right-align under the trigger, then clamp into the viewport (both axes).
    const left = Math.max(8, Math.min(r.right - mw, vw - mw - 8));
    let top = r.bottom + 4;
    if (top + mh > vh - 8) top = Math.max(8, r.top - mh - 4); // flip above if it'd overflow the bottom
    setPos({ top, left });
  }, []);

  // Close on any outside click (the trigger and menu stopPropagation), and on
  // scroll of an *ancestor* — a fixed menu doesn't follow a scrolling ancestor, so
  // dismiss instead. But scrolling inside the menu itself (a long, overflow-scroll
  // list) must NOT close it, so ignore scroll events originating within the menu.
  useEffect(() => {
    const close = () => onClose();
    const onScroll = (e: Event) => { if (!menuRef.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener("click", close);
    window.addEventListener("scroll", onScroll, true);
    return () => { window.removeEventListener("click", close); window.removeEventListener("scroll", onScroll, true); };
  }, [onClose]);

  return (
    <>
      <span ref={markerRef} style={{ display: "none" }} />
      {createPortal(
        <div
          ref={menuRef}
          className="popover"
          style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left ?? -9999, right: "auto", visibility: pos ? "visible" : "hidden" }}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}
