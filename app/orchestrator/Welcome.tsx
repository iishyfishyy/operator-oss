"use client";

import { useState } from "react";
import { Icon } from "../icons";
import { Modal } from "./Modal";

// Coach marks + the post-merge nudge for the built-in "Welcome" tutorial project
// (projects.seeded = 1). These carry the "how Operator works" teaching that we
// deliberately keep OUT of the Claude-facing project context — so the concepts
// live where the user reads them, not where the agent does.

const COACH_KEY = "orch:welcomeCoach:dismissed";

// A slim, dismissible bar above the tutorial session. Names the three-column loop
// and the three beats of the task the user is about to run.
export function WelcomeCoach() {
  const [gone, setGone] = useState<boolean>(() => {
    try { return localStorage.getItem(COACH_KEY) === "1"; } catch { return false; }
  });
  if (gone) return null;
  const dismiss = () => {
    try { localStorage.setItem(COACH_KEY, "1"); } catch {}
    setGone(true);
  };

  const steps: [string, string][] = [
    ["Start", "Press Start and watch Claude stream its tool calls live."],
    ["Answer", "It’ll pause to ask you a quick question — pick an option."],
    ["Review & merge", "Open Changes, read the diff, then one-click merge."],
  ];

  return (
    <div className="wcoach">
      <div className="wcoach-head">
        <span className="wcoach-ic">{Icon.bolt()}</span>
        <div className="wcoach-title">Welcome — this is a live 2-minute tour</div>
        <button className="wcoach-x" onClick={dismiss} title="Dismiss">{Icon.x()}</button>
      </div>
      <div className="wcoach-sub">
        Three columns: <strong>Projects</strong> (left) · <strong>Tasks</strong> in this project · the <strong>Live session</strong> (right).
        Run the “Try me” task below to see the whole loop end to end.
      </div>
      <div className="wcoach-steps">
        {steps.map(([label, body], i) => (
          <div className="wcoach-step" key={label}>
            <span className="wcoach-num">{i + 1}</span>
            <div>
              <div className="wcoach-step-t">{label}</div>
              <div className="wcoach-step-b">{body}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Fires once the tutorial task is merged: the aha moment landed, so this is the
// natural place to point the user at their own code (and, since we dropped the
// notifications step from the wizard, to offer the browser-notification opt-in).
export function WelcomeNudge({ onCreateProject, onClose }: { onCreateProject: () => void; onClose: () => void }) {
  const notifSupported = typeof window !== "undefined" && "Notification" in window;
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">(
    notifSupported ? Notification.permission : "unsupported"
  );
  const enableNotifs = async () => {
    if (!notifSupported) return;
    try { setPerm(await Notification.requestPermission()); } catch {}
  };

  return (
    <Modal
      title="You just ran the whole loop 🎉"
      sub="Streaming · a question · a diff · a merge — all in your own workspace."
      onClose={onClose}
      width={520}
      footer={<>
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={onClose}>Keep exploring</button>
        <button className="btn btn-accent" onClick={onCreateProject}>{Icon.plus()} Create a project</button>
      </>}
    >
      <p style={{ margin: "0 0 14px", color: "var(--ink-2)", lineHeight: 1.55 }}>
        That’s the core of Operator: every task is its own agent session in its own git worktree, so
        you review and merge on your terms. Ready to point it at your own code? You can delete this
        Welcome project any time.
      </p>
      {perm === "default" && notifSupported && (
        <button className="btn btn-line" onClick={enableNotifs} style={{ alignSelf: "flex-start" }}>
          {Icon.spark()} Notify me when a task needs me
        </button>
      )}
      {perm === "granted" && (
        <div className="hlp" style={{ margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "var(--green, var(--accent))", display: "inline-flex" }}>{Icon.check()}</span>
          Notifications on — step away while sessions run.
        </div>
      )}
    </Modal>
  );
}
