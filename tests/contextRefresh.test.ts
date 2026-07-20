import { describe, expect, it, vi } from "vitest";

// "Refresh with AI" drafts via the project's agent driver (resolved through
// lib/agents/registry.ts); stub the Claude driver module so these tests
// exercise the detached-job state machine without spawning a real agent.
vi.mock("../lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Claude Code",
    draftProjectContext: vi.fn(async () => "DRAFTED CONTEXT"),
  },
}));

import { createProject, getProject, setProjectRefresh } from "../lib/store";
import {
  startRefreshJob,
  getRefreshState,
  clearRefresh,
  isRefreshing,
} from "../lib/contextRefresh";
import { activity, workStarted, workEnded } from "../lib/idle";
import { setAgentConnection } from "../lib/agents/connections";

// Utility-agent resolution is connected-first (lib/agents/oneshots.ts): with no
// connection on record the draft job fails fast with a "connect an agent" error
// instead of reaching the stubbed driver. Record one so the job runs.
setAgentConnection("claude", { method: "subscription", email: null, plan: null });

// Poll the persisted state until the background draft leaves "running".
async function waitDone(projectId: string, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (getRefreshState(projectId)?.status !== "running") return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("refresh job never settled");
}

describe("detached refresh job", () => {
  it("persists state transitions via setProjectRefresh", () => {
    const project = createProject({ name: "Ctx" });
    expect(getProject(project.id)!.refresh_status).toBe("idle");

    const startedAt = Date.now();
    setProjectRefresh(project.id, { refresh_status: "running", refresh_started_at: startedAt });
    expect(getRefreshState(project.id)).toMatchObject({ status: "running", started_at: startedAt });

    // A concurrent project edit must NOT clobber refresh state, and vice-versa.
    setProjectRefresh(project.id, { refresh_status: "done", refresh_draft: "X" });
    expect(getProject(project.id)!.refresh_status).toBe("done");
    expect(getProject(project.id)!.refresh_draft).toBe("X");
  });

  it("errors immediately when the project has no working directory", () => {
    const project = createProject({ name: "NoRepo" });
    const state = startRefreshJob(project.id);
    expect(state.status).toBe("error");
    expect(state.error).toMatch(/working directory/);
    expect(isRefreshing(project.id)).toBe(false);
  });

  it("runs the draft in the background and persists the result", async () => {
    const project = createProject({ name: "HasRepo", repo_path: "/tmp/not-a-real-repo-xyz" });
    const started = startRefreshJob(project.id);
    expect(started.status).toBe("running");

    await waitDone(project.id);
    const done = getRefreshState(project.id)!;
    expect(done.status).toBe("done");
    expect(done.draft).toBe("DRAFTED CONTEXT");
    expect(isRefreshing(project.id)).toBe(false);
    // openWork must be released so the container isn't kept "busy" forever.
    expect(activity().openWork).toBe(0);

    // Acknowledge the consumed draft → back to idle, draft cleared.
    const cleared = clearRefresh(project.id);
    expect(cleared).toMatchObject({ status: "idle", draft: "" });
  });

  it("ignores a double-click while a job is genuinely running", () => {
    const project = createProject({ name: "Fresh", repo_path: "/tmp/whatever" });
    setProjectRefresh(project.id, { refresh_status: "running", refresh_started_at: Date.now() });
    // No live in-flight job, but the row is fresh → treated as running, no restart.
    expect(startRefreshJob(project.id).status).toBe("running");
  });

  it("restarts a stale 'running' row left orphaned by a server restart", () => {
    const project = createProject({ name: "Stale" }); // no repo_path
    setProjectRefresh(project.id, {
      refresh_status: "running",
      refresh_started_at: Date.now() - 11 * 60 * 1000, // older than STALE_MS
    });
    // A poll of the orphaned row also reports a settled error, so the client
    // unsticks instead of showing "Reading the repo…" forever.
    expect(getRefreshState(project.id)).toMatchObject({ status: "error" });
    // Stale + not in-flight → bypasses the running short-circuit and re-evaluates;
    // with no repo_path that surfaces as an error rather than a stuck "running".
    expect(startRefreshJob(project.id).status).toBe("error");
  });

  it("counts background work as activity (clamped at zero)", () => {
    const before = activity().openWork;
    workStarted();
    expect(activity().openWork).toBe(before + 1);
    workEnded();
    expect(activity().openWork).toBe(before);
    workEnded(); // underflow guarded
    expect(activity().openWork).toBe(before);
  });

  it("returns null state for an unknown project", () => {
    expect(getRefreshState("nope")).toBeNull();
  });
});
