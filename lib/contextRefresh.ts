import { getProject, setProjectRefresh } from "./store";
import { draftProjectContext } from "./agents/oneshots";
import { recentCommits, isGitRepo } from "./git";
import { workStarted, workEnded } from "./idle";
import type { Project } from "./types";

// Projects whose draft is genuinely executing in THIS process. The DB
// refresh_status is the durable source of truth a client polls; this in-memory
// set is the liveness truth used to (a) ignore a double-click and (b) detect a
// "running" row left orphaned by a server restart. Module-level = per server.
const inFlight = new Set<string>();

// A DB row stuck at "running" with no live job (e.g. the process was killed
// mid-draft) is treated as restartable after this long.
const STALE_MS = 10 * 60 * 1000;

export type RefreshState = {
  status: Project["refresh_status"];
  draft: string;
  error: string;
  started_at: number;
};

export function isRefreshing(projectId: string): boolean {
  return inFlight.has(projectId);
}

function stateOf(p: Project): RefreshState {
  // A "running" row with no live in-process job and an old start time was
  // orphaned by a server restart — report it as a settled error so a polling
  // client unsticks (and can retry) instead of waiting forever.
  if (
    p.refresh_status === "running" &&
    !inFlight.has(p.id) &&
    Date.now() - p.refresh_started_at > STALE_MS
  ) {
    return { status: "error", draft: "", error: "refresh timed out — try again", started_at: p.refresh_started_at };
  }
  return {
    status: p.refresh_status,
    draft: p.refresh_draft,
    error: p.refresh_error,
    started_at: p.refresh_started_at,
  };
}

/** Current persisted refresh state for a project (for the client to poll). */
export function getRefreshState(projectId: string): RefreshState | null {
  const p = getProject(projectId);
  return p ? stateOf(p) : null;
}

/**
 * Acknowledge a finished (done/error) draft: clear it back to idle so it doesn't
 * resurface next time the modal opens. No-op while a job is genuinely running.
 */
export function clearRefresh(projectId: string): RefreshState | null {
  if (inFlight.has(projectId)) return getRefreshState(projectId);
  const p = setProjectRefresh(projectId, { refresh_status: "idle", refresh_draft: "", refresh_error: "" });
  return p ? stateOf(p) : null;
}

// Assemble the seed digest handed to the drafting agent: recent git activity so
// the model knows what's changed lately. The agent reads the code itself; this
// is just orientation.
async function buildDigest(repoPath: string): Promise<string> {
  if (!repoPath || !(await isGitRepo(repoPath).catch(() => false))) return "";
  const commits = await recentCommits(repoPath, 15).catch(() => "");
  return commits ? `## Recent git commits\n${commits}` : "";
}

// The actual draft, run detached. Marks the instance busy for its whole life so
// the control plane can't sleep the container mid-draft, and persists the
// outcome (done+draft or error) so a client that reconnects later still gets it.
async function runDraft(project: Project): Promise<void> {
  workStarted();
  try {
    const digest = await buildDigest(project.repo_path);
    const draft = await draftProjectContext(project, digest);
    setProjectRefresh(project.id, { refresh_status: "done", refresh_draft: draft, refresh_error: "" });
  } catch (e) {
    setProjectRefresh(project.id, {
      refresh_status: "error",
      refresh_error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    workEnded();
    inFlight.delete(project.id);
  }
}

/**
 * Kick off a refreshed project-context draft in the BACKGROUND and return the
 * resulting state immediately — the agent exploration (which can take minutes)
 * no longer runs inside the HTTP request. The client polls getRefreshState()
 * until the status leaves "running", then reviews/saves the draft. Idempotent
 * on a double-click: a live job is left running and its state returned.
 */
export function startRefreshJob(projectId: string): RefreshState {
  const project = getProject(projectId);
  if (!project) throw new Error("project not found");

  // A genuinely live job (or a recent, not-yet-stale "running" row) wins — don't
  // start a parallel exploration for the same project.
  const liveOrFresh =
    inFlight.has(projectId) ||
    (project.refresh_status === "running" && Date.now() - project.refresh_started_at < STALE_MS);
  if (liveOrFresh) return stateOf(project);

  if (!project.repo_path) {
    const p = setProjectRefresh(projectId, {
      refresh_status: "error",
      refresh_error: "set a working directory before refreshing context",
    });
    return stateOf(p ?? project);
  }

  inFlight.add(projectId);
  const p = setProjectRefresh(projectId, {
    refresh_status: "running",
    refresh_draft: "",
    refresh_error: "",
    refresh_started_at: Date.now(),
  });
  // Fire-and-forget: the request returns now; runDraft persists the outcome.
  void runDraft(p ?? project);
  return stateOf(p ?? project);
}
