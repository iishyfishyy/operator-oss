"use client";

import { Icon } from "../icons";
import { Markdown } from "../Markdown";
import { relTime } from "./format";
import { ErrNote } from "./shared";
import type { ProjectRow, RecapInfo } from "./types";

// Shown in the session pane when a project is open but no task is selected.
// Surfaces the auto-generated "where you left off" recap when one exists / is
// brewing; otherwise the plain create-a-task prompt.
export function ProjectLanding({ project, recap, onNewTask, onRefreshRecap }: {
  project: ProjectRow; recap?: RecapInfo; onNewTask: () => void; onRefreshRecap: () => void;
}) {
  const generating = recap?.generating && !recap?.recap;
  const hasRecap = !!recap?.recap;

  if (generating) {
    return (
      <div className="empty" style={{ margin: "auto" }}>
        <div className="e-ic">{Icon.clock()}</div>
        <div className="e-t">Catching you up…</div>
        <div className="e-s">Recapping where you left off in {project.name}.</div>
        <span className="typing" style={{ marginTop: 14 }}><i /><i /><i /></span>
      </div>
    );
  }

  // Recap fetch/generation failed and there's nothing older to show — offer a
  // retry rather than silently falling through to the plain empty state.
  if (recap?.error && !hasRecap) {
    return (
      <div className="empty" style={{ margin: "auto", maxWidth: 340 }}>
        <div className="e-ic">{Icon.clock()}</div>
        <div className="e-t">Couldn&apos;t catch you up</div>
        <div className="e-s">The recap for {project.name} didn&apos;t load: {recap.error}</div>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 16 }}>
          <button className="btn btn-line" onClick={onRefreshRecap}>{Icon.restore()} Try again</button>
          <button className="btn btn-accent" onClick={onNewTask}>{Icon.plus()} New task</button>
        </div>
      </div>
    );
  }

  if (hasRecap) {
    return (
      <div className="transcript">
        <div className="tw" style={{ maxWidth: 720 }}>
          <div className="recap-card">
            <div className="recap-head">
              <span className="recap-badge">{Icon.clock()} Where you left off</span>
              <span className="recap-meta">{recap!.recap_at ? `recapped ${relTime(recap!.recap_at)}` : ""}</span>
              <span className="spacer" />
              <button
                className="btn btn-line btn-sm"
                onClick={onRefreshRecap}
                disabled={recap!.generating}
                title="Regenerate this recap from the latest activity"
              >
                {Icon.clear()} {recap!.generating ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            {recap!.error && !recap!.generating && (
              <ErrNote style={{ margin: "12px 14px 0" }}>Refresh failed: {recap!.error}</ErrNote>
            )}
            <div className="recap-body"><Markdown>{recap!.recap ?? ""}</Markdown></div>
            <div className="recap-foot">
              <span className="recap-meta">Pick up a task to continue, or start a new one.</span>
              <span className="spacer" />
              <button className="btn btn-accent btn-sm" onClick={onNewTask}>{Icon.plus()} New task</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="empty" style={{ margin: "auto" }}>
      <div className="e-ic">{Icon.bolt()}</div>
      <div className="e-t">No task selected</div>
      <div className="e-s">Create a task to start an agent session.</div>
      <button className="btn btn-accent" style={{ marginTop: 16 }} onClick={onNewTask}>{Icon.plus()} New task</button>
    </div>
  );
}
