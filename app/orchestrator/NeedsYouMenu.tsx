"use client";

import { useEffect, useState } from "react";
import { Popover, LoadNote } from "./shared";
import { jget } from "./api";
import { waitedFor } from "./format";
import type { NeedsYouRow } from "./types";

// The titlebar "N need you" dropdown. Replaces the old click-to-jump pill: clicking
// the pill now opens this list of every task waiting on the user across all active
// projects, each row showing its project, title, and "waiting for <duration>" age.
// Picking a row jumps straight to that task (in its project). Rows are fetched fresh
// on open so the ages and membership are always current; the longest-waiting task
// sits at the top (server orders by waiting_since ASC).
export function NeedsYouMenu({ onJump, onClose }: { onJump: (projectId: string, taskId: string) => void; onClose: () => void }) {
  const [rows, setRows] = useState<NeedsYouRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    jget<{ tasks: NeedsYouRow[] }>("/api/needs-you")
      .then((d) => { if (alive) setRows(d.tasks); })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, []);

  return (
    <Popover onClose={onClose}>
      <div className="ny-menu">
        <div className="pop-sec">Waiting on you</div>
        {rows === null ? (
          <LoadNote style={{ padding: "10px 14px 14px" }}>Checking waiting tasks…</LoadNote>
        ) : rows.length === 0 ? (
          <div className="ny-empty">Nothing waiting right now.</div>
        ) : (
          rows.map((r) => (
            <button
              key={r.id}
              className="ny-row"
              onClick={() => { onJump(r.project_id, r.id); onClose(); }}
            >
              <span className="ny-proj" style={{ background: r.project_color }} title={r.project_name}>
                {(r.project_icon || r.project_name[0] || "?").toUpperCase()}
              </span>
              <span className="ny-text">
                <span className="ny-title">{r.title}</span>
                <span className="ny-sub">{r.project_name} · waiting for {waitedFor(r.waiting_since)}</span>
              </span>
            </button>
          ))
        )}
      </div>
    </Popover>
  );
}
