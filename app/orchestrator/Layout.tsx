"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { TerminalView } from "../Terminal";
import { Skel } from "./shared";

// Skeleton stand-in for one task card (tasks column, boot skeleton). Width
// varies per index so the stack doesn't read as a repeated stamp.
export function TaskCardSkeleton({ i = 0 }: { i?: number }) {
  const widths = [58, 42, 66, 38];
  return (
    <div className="task" style={{ cursor: "default" }} aria-hidden>
      <div className="task-top">
        <Skel w={9} h={9} r="50%" />
        <Skel w={`${widths[i % widths.length]}%`} h={12} />
        <span style={{ flex: 1 }} />
        <Skel w={34} h={10} />
      </div>
      <div className="task-foot">
        <Skel w={120} h={9} />
      </div>
    </div>
  );
}

// First-paint placeholder for the whole workspace, shown while the initial
// project fetch is in flight so the three columns don't flash empty. Mirrors
// the real column chrome (headers, banner, cards) so the swap to live data
// doesn't jump.
export function BootSkeleton({ mobile }: { mobile?: boolean }) {
  const projectsCol = (
    <div className="col col-projects" aria-hidden>
      <div className="col-head"><span className="ch-title">Projects</span></div>
      <div className="proj-list">
        {[64, 48, 56].map((w, i) => (
          <div key={i} className="proj" style={{ cursor: "default" }}>
            <Skel w={30} h={30} r={9} />
            <div className="pmeta" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <Skel w={`${w}%`} h={11} />
              <Skel w={`${w - 20}%`} h={8} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
  if (mobile) return projectsCol;
  return (
    <>
      {projectsCol}
      <div className="col col-tasks" aria-hidden>
        <div className="proj-banner">
          <div className="pb-row">
            <Skel w={34} h={34} r={10} />
            <Skel w={140} h={15} />
          </div>
          <Skel w="100%" h={40} r="var(--r)" style={{ marginTop: 10 }} />
        </div>
        <div className="task-scroll">
          {[0, 1, 2].map((i) => <TaskCardSkeleton key={i} i={i} />)}
        </div>
      </div>
      <div className="col col-session" aria-hidden>
        <div className="empty" style={{ margin: "auto" }}>
          <span className="typing"><i /><i /><i /></span>
        </div>
      </div>
    </>
  );
}

// Drag-to-resize handle sitting between two columns. By default it measures the
// column to its left (previousElementSibling) so the new width is independent of
// whatever sits further left — collapsed rails, varying project widths, etc.
// With side="right" it instead sizes the column to its right (the rail), pinning
// to that column's right edge so the width grows as you drag left. Double-click
// snaps back to the default width.
export function ColResize({ min, max, onWidth, onReset, side = "left" }: { min: number; max: number; onWidth: (w: number) => void; onReset: () => void; side?: "left" | "right" }) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // Keep the latest onWidth in a ref so the window listeners can be attached
  // exactly once. Re-subscribing on every render (onWidth is a fresh closure)
  // tears the listeners down mid-drag and drops mousemove events.
  const onWidthRef = useRef(onWidth);
  onWidthRef.current = onWidth;
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current) return;
      if (side === "right") {
        const col = ref.current?.nextElementSibling as HTMLElement | null;
        if (!col) return;
        const right = col.getBoundingClientRect().right;
        onWidthRef.current(Math.max(min, Math.min(max, Math.round(right - e.clientX))));
        return;
      }
      const col = ref.current?.previousElementSibling as HTMLElement | null;
      if (!col) return;
      const left = col.getBoundingClientRect().left;
      onWidthRef.current(Math.max(min, Math.min(max, Math.round(e.clientX - left))));
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [min, max, side]);
  // Zero-width seam marker; the actual grab target is an absolutely-positioned
  // bar that straddles the border with a comfortable hit width and sits above the
  // neighboring columns (no negative-margin overlap that could swallow clicks).
  return (
    <div ref={ref} className="col-resize" aria-hidden>
      <span
        className="col-resize-bar"
        title="Drag to resize · double-click to reset"
        onMouseDown={() => { dragging.current = true; document.body.style.userSelect = "none"; document.body.style.cursor = "col-resize"; }}
        onDoubleClick={onReset}
      />
    </div>
  );
}

// Collapsed sidebar — a slim vertical rail that reclaims a panel's space for the
// chat while leaving a one-click way to bring it back.
export function ColRail({ label, task, right, onExpand }: { label: string; task?: boolean; right?: boolean; onExpand: () => void }) {
  return (
    <button className={`col-rail${task ? " rail-task" : ""}${right ? " rail-right" : ""}`} onClick={onExpand} title={`Show ${label.toLowerCase()} panel`}>
      {Icon.chevRight()}
      <span className="rail-label">{label}</span>
    </button>
  );
}

export function TerminalDrawer({ cwd, port, visible, height, onClose, onResize }: { cwd: string; port?: number; visible: boolean; height: number; onClose: () => void; onResize: (h: number) => void }) {
  const dragging = useRef(false);
  // Remount key for the terminal — bumping it kills the current shell and spawns a fresh one.
  const [epoch, setEpoch] = useState(0);
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

  return (
    <div className={`term-drawer${visible ? "" : " collapsed"}`} style={visible ? { height } : undefined}>
      <div className="term-resize" onMouseDown={() => { dragging.current = true; document.body.style.userSelect = "none"; }} />
      <div className="term-bar">
        {Icon.terminal()}
        <span className="term-title">Terminal</span>
        <span className="term-cwd">{cwd || "~ (no working dir set for this project)"}{port ? `  ·  PORT=${port}` : ""}</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={() => setEpoch((e) => e + 1)} title="Restart terminal (kills the current shell and starts a new one)">{Icon.clear()}</button>
        <button className="icon-btn" onClick={onClose} title="Hide terminal (the shell keeps running)">{Icon.chevDown()}</button>
      </div>
      {/* keep TerminalView mounted even when collapsed so long-running processes (npm run dev) survive */}
      <TerminalView key={epoch} cwd={cwd} port={port} />
    </div>
  );
}
