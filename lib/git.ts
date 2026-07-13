import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { WORKTREES_DIR } from "./config";
import { withRepoLock } from "./repoLock";

const run = promisify(execFile);

// Worktrees live OUTSIDE the orchestrator project (ORCH_WORKTREES_DIR, default
// ~/.agent-orchestrator/worktrees), keyed by task id. Each is a real git
// worktree of the *project's* repo, so a task gets an isolated checkout +
// branch and parallel tasks never collide. Keeping them out of the project
// root is essential: nested checkouts under the Next app would be swept up by
// tsc/eslint and would thrash the dev watcher every time an agent writes a file.

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repoPath, ...args]);
  return stdout.trim();
}

/** True if `dir` is inside a git work tree. */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

/** True if the repo has at least one commit (worktrees can't branch from an empty HEAD). */
async function hasCommit(repoPath: string): Promise<boolean> {
  try {
    await git(repoPath, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

export const branchForTask = (taskId: string) => `orch/${taskId}`;

// Commit whatever is currently in the repo as the project baseline. Writes a
// sensible default .gitignore first (so a base commit doesn't swallow
// node_modules), and uses a fallback identity if the user has none configured.
async function baseCommit(repoPath: string): Promise<void> {
  const gi = path.join(repoPath, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, "node_modules/\n.next/\ndist/\nbuild/\n.DS_Store\n*.log\n");
  await git(repoPath, ["add", "-A"]);
  const args = ["commit", "--allow-empty", "-m", "Initial project state (orchestrator)", "--no-verify"];
  try {
    await git(repoPath, args);
  } catch {
    await git(repoPath, ["-c", "user.name=Orchestrator", "-c", "user.email=orchestrator@local", ...args]);
  }
}

// Initialize a fresh git repo (on `main`) and make the baseline commit.
async function initRepo(repoPath: string): Promise<void> {
  try {
    await git(repoPath, ["init", "-b", "main"]);
  } catch {
    await git(repoPath, ["init"]); // older git without -b
  }
  await baseCommit(repoPath);
}

/** Best-effort recent commit log (one `hash date subject` per line). "" if not a git repo. */
export async function recentCommits(repoPath: string, n = 10): Promise<string> {
  if (!repoPath || !(await isGitRepo(repoPath))) return "";
  try {
    return await git(repoPath, ["log", `-${n}`, "--pretty=format:%h %ad %s", "--date=short"]);
  } catch {
    return "";
  }
}

/**
 * Create an isolated git worktree + branch for a task, branched from the repo's
 * current HEAD. Returns the worktree path and branch, or `null` when isolation
 * isn't possible (not a git repo, or no commits yet) — the caller then falls
 * back to running directly in the project's repo path.
 */
export async function ensureWorktree(
  repoPath: string,
  taskId: string
): Promise<{ path: string; branch: string; baseSha: string } | null> {
  // Serialize with merges and other worktree creations on the same repo: both
  // touch the shared worktree registry / read HEAD for the base sha, and a merge
  // racing this could hand back a base_sha read off a transient HEAD.
  return withRepoLock(repoPath, () => ensureWorktreeLocked(repoPath, taskId));
}

async function ensureWorktreeLocked(
  repoPath: string,
  taskId: string
): Promise<{ path: string; branch: string; baseSha: string } | null> {
  // Greenfield (non-git) or commitless repo: initialize it so the task can be
  // isolated. Without this, every orchestrator-created project — which starts
  // as a bare folder — would silently skip isolation and have nothing to diff.
  if (!(await isGitRepo(repoPath))) await initRepo(repoPath);
  else if (!(await hasCommit(repoPath))) await baseCommit(repoPath);
  // If init didn't take (e.g. permissions), fall back to running in repo_path.
  if (!(await isGitRepo(repoPath)) || !(await hasCommit(repoPath))) return null;

  const wtPath = path.join(WORKTREES_DIR, taskId);
  const branch = branchForTask(taskId);
  // The commit the task branches from — the stable base for diff + merge.
  const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });

  // Already linked (e.g. retry after a failed first launch) — reuse it.
  if (fs.existsSync(wtPath)) return { path: wtPath, branch, baseSha };

  try {
    await git(repoPath, ["worktree", "add", "-b", branch, wtPath]);
  } catch {
    // Branch may already exist from a prior generation; attach to it instead.
    await git(repoPath, ["worktree", "add", wtPath, branch]);
  }
  return { path: wtPath, branch, baseSha };
}

/**
 * Best-effort teardown of a task's worktree. Never throws.
 *
 * By default this also deletes the task's branch (full teardown, as on task or
 * project delete). Pass `{ keepBranch: true }` to reclaim the worktree's disk
 * while preserving the branch — that's what the "prune merged worktrees"
 * cleanup does, since the branch is the diff base for reopening an old task and
 * deleting it would lose the ability to view that task's changes.
 */
export async function removeWorktree(
  repoPath: string,
  wtPath: string,
  branch: string,
  opts: { keepBranch?: boolean } = {}
): Promise<void> {
  if (!wtPath) return;
  try {
    await git(repoPath, ["worktree", "remove", "--force", wtPath]);
  } catch {
    // Fall back to removing the directory and pruning the stale registration.
    try {
      fs.rmSync(wtPath, { recursive: true, force: true });
      await git(repoPath, ["worktree", "prune"]);
    } catch {}
  }
  if (branch && !opts.keepBranch) {
    try {
      await git(repoPath, ["branch", "-D", branch]);
    } catch {}
  }
}

/**
 * Disk footprint of a worktree directory in bytes (actual blocks used, via
 * `du`), or 0 if it's gone or can't be measured. Used to show how much a stale
 * merged worktree is costing before the user decides to prune it.
 */
export async function worktreeDiskUsage(wtPath: string): Promise<number> {
  if (!wtPath || !fs.existsSync(wtPath)) return 0;
  try {
    // -s: summary for the dir; -k: 1024-byte blocks (portable across macOS/Linux).
    const { stdout } = await run("du", ["-sk", wtPath]);
    const kb = parseInt(stdout.trim().split(/\s+/)[0], 10);
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch {
    return 0;
  }
}

// ---------- prune safety ----------

export interface PruneSafety {
  safe: boolean; // removing the worktree would lose no work
  isDirty: boolean; // uncommitted changes present (discarded by `remove --force`)
  ahead: number; // commits on the work branch not yet in the base branch
  reason?: string; // why it's unsafe — surfaced to the user
}

/**
 * Whether a merged task's worktree can be removed WITHOUT losing work — the
 * safety gate for the "prune merged worktrees" cleanup.
 *
 * `merged_at` only records that a task was merged AT LEAST ONCE, and it's never
 * cleared, but the product supports merging several rounds while continuing to
 * iterate. So a task flagged "merged" may since have grown work that is NOT in
 * the base branch. Removing its worktree would then be silent data loss:
 * `git worktree remove --force` discards uncommitted edits, and (with
 * delete-branch) `git branch -D` orphans commits made after the merge.
 *
 * Unsafe when the worktree is dirty (uncommitted edits) OR the work branch is
 * ahead of the base branch (commits not yet merged). Read-only; never mutates.
 */
export async function worktreePruneSafety(input: {
  repoPath: string;
  worktreePath: string;
  workBranch: string;
  baseBranch: string;
}): Promise<PruneSafety> {
  const { repoPath, worktreePath, workBranch, baseBranch } = input;
  if (!worktreePath) return { safe: true, isDirty: false, ahead: 0 };

  const isDirty = (await git(worktreePath, ["status", "--porcelain"]).catch(() => "")).trim().length > 0;

  // Commits on the work branch that the base branch hasn't yet absorbed. Compared
  // against the base BRANCH (not the recorded base_sha) so it reflects git reality
  // regardless of merged_at bookkeeping.
  let ahead = 0;
  if (workBranch && (await branchExists(repoPath, workBranch)) && (await branchExists(repoPath, baseBranch))) {
    ahead = parseInt(await git(repoPath, ["rev-list", "--count", `${baseBranch}..${workBranch}`]).catch(() => "0"), 10) || 0;
  }

  const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;
  const reason =
    isDirty && ahead > 0
      ? `uncommitted changes + ${commits(ahead)} not yet in ${baseBranch || "the base branch"}`
      : isDirty
        ? "uncommitted changes not saved to any branch"
        : ahead > 0
          ? `${commits(ahead)} not yet in ${baseBranch || "the base branch"}`
          : undefined;

  return { safe: !isDirty && ahead === 0, isDirty, ahead, reason };
}

// ---------- diff ----------

export interface DiffFile {
  path: string;
  status: string; // A | M | D | R | ? (untracked)
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string; // this file's own unified diff
  truncated?: boolean; // this file's patch was clipped
}

export interface TaskDiff {
  base: string; // resolved base commit/ref
  baseLabel: string; // human label (branch name or short sha)
  files: DiffFile[];
  isDirty: boolean; // uncommitted changes present in the worktree
  ahead: number; // commits on the branch beyond base
  alreadyMerged: boolean; // every branch commit is reachable from the base branch
}

const MAX_FILE_PATCH = 60_000;

const stdoutOf = (e: unknown): string =>
  e && typeof e === "object" && "stdout" in e ? String((e as { stdout: unknown }).stdout ?? "") : "";
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Resolve a usable diff base inside the worktree: prefer the stored base sha,
// fall back to the merge-base with the project's base branch, then the root commit.
async function resolveBase(worktreePath: string, baseSha: string, baseBranch: string): Promise<string> {
  if (baseSha) {
    try {
      await git(worktreePath, ["cat-file", "-e", `${baseSha}^{commit}`]);
      return baseSha;
    } catch {}
  }
  if (baseBranch) {
    try {
      return await git(worktreePath, ["merge-base", baseBranch, "HEAD"]);
    } catch {}
  }
  try {
    const roots = await git(worktreePath, ["rev-list", "--max-parents=0", "HEAD"]);
    return roots.split("\n").filter(Boolean).pop() || "HEAD";
  } catch {
    return "HEAD";
  }
}

/**
 * Everything a task changed versus its base: committed + uncommitted tracked
 * changes (`git diff <base>`) plus untracked files (shown as additions).
 */
export async function taskDiff(
  repoPath: string,
  worktreePath: string,
  baseSha: string,
  baseBranch: string
): Promise<TaskDiff> {
  const base = await resolveBase(worktreePath, baseSha, baseBranch);
  const baseLabel = baseBranch || base.slice(0, 7);

  const files: DiffFile[] = [];
  const byPath = new Map<string, DiffFile>();

  const nameStatus = await git(worktreePath, ["diff", "--name-status", base, "--"]).catch(() => "");
  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const f: DiffFile = { path: parts[parts.length - 1], status: parts[0][0], additions: 0, deletions: 0, binary: false, patch: "" };
    byPath.set(f.path, f);
    files.push(f);
  }
  const numstat = await git(worktreePath, ["diff", "--numstat", base, "--"]).catch(() => "");
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [add, del, ...rest] = line.split("\t");
    const f = byPath.get(rest.join("\t"));
    if (!f) continue;
    if (add === "-" || del === "-") f.binary = true;
    else {
      f.additions = parseInt(add, 10) || 0;
      f.deletions = parseInt(del, 10) || 0;
    }
  }

  // Per-file patch for tracked changes (one diff per path — robust to render).
  for (const f of files) {
    let p = await git(worktreePath, ["diff", base, "--", f.path]).catch(() => "");
    if (p.length > MAX_FILE_PATCH) {
      p = p.slice(0, MAX_FILE_PATCH);
      f.truncated = true;
    }
    f.patch = p;
  }

  // Untracked files aren't in `git diff <base>` — diff each via --no-index.
  const untracked = (await git(worktreePath, ["ls-files", "--others", "--exclude-standard"]).catch(() => ""))
    .split("\n")
    .filter(Boolean);
  for (const p of untracked) {
    let body = "";
    try {
      body = await git(worktreePath, ["diff", "--no-index", "--", "/dev/null", p]);
    } catch (e) {
      body = stdoutOf(e); // --no-index exits 1 when files differ
    }
    const binary = /^Binary files /m.test(body);
    const additions = binary ? 0 : body.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
    let truncated = false;
    if (body.length > MAX_FILE_PATCH) {
      body = body.slice(0, MAX_FILE_PATCH);
      truncated = true;
    }
    files.push({ path: p, status: "?", additions, deletions: 0, binary, patch: body, truncated });
  }

  const isDirty = (await git(worktreePath, ["status", "--porcelain"]).catch(() => "")).trim().length > 0;
  let ahead = 0;
  try {
    ahead = parseInt(await git(worktreePath, ["rev-list", "--count", `${base}..HEAD`]), 10) || 0;
  } catch {}

  // Already merged if every commit on this branch is reachable from the base
  // branch. Catches merges done outside the app's merge button (CLI, etc).
  // `--is-ancestor` exits 0 when HEAD is an ancestor of baseBranch, 1 otherwise.
  let alreadyMerged = false;
  if (baseBranch) {
    alreadyMerged = await git(worktreePath, ["merge-base", "--is-ancestor", "HEAD", baseBranch])
      .then(() => true)
      .catch(() => false);
  }

  return { base, baseLabel, files, isDirty, ahead, alreadyMerged };
}

// ---------- merge ----------

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  if (!branch) return false;
  try {
    await git(repoPath, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function currentBranch(repoPath: string): Promise<string> {
  try {
    return await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    return "";
  }
}

/** Stage + commit everything in the worktree. Returns false if nothing to commit. */
export async function commitWorktree(worktreePath: string, message: string): Promise<boolean> {
  const dirty = (await git(worktreePath, ["status", "--porcelain"]).catch(() => "")).trim().length > 0;
  if (!dirty) return false;
  await git(worktreePath, ["add", "-A"]);
  try {
    await git(worktreePath, ["commit", "-m", message, "--no-verify"]);
  } catch {
    // No committer identity configured — commit with a local fallback.
    await git(worktreePath, [
      "-c",
      "user.name=Orchestrator",
      "-c",
      "user.email=orchestrator@local",
      "commit",
      "-m",
      message,
      "--no-verify",
    ]);
  }
  return true;
}

export interface MergeResult {
  ok: boolean;
  targetBranch: string;
  committed: boolean;
  alreadyMerged?: boolean;
  conflicts?: string[];
  error?: string;
  mergedSha?: string; // the work-branch tip that was merged — the new diff base
  additions?: number; // line stats of what this merge landed on the target
  deletions?: number; // (absent when alreadyMerged / stats couldn't be read)
}

// Line stats of the merge that just completed in `dir`: ORIG_HEAD (the target's
// pre-merge tip, set by `git merge`) → HEAD. Read immediately after a successful
// merge, before the throwaway worktree is torn down — worktrees don't survive
// their task, so merge time is the only chance to persist these. Best-effort:
// a failure just omits the stats. Binary files count 0 ("-" in numstat).
async function mergeLineStats(dir: string): Promise<{ additions: number; deletions: number } | null> {
  try {
    const out = await git(dir, ["diff", "--numstat", "ORIG_HEAD", "HEAD"]);
    let additions = 0, deletions = 0;
    for (const line of out.split("\n")) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
      if (!m) continue;
      if (m[1] !== "-") additions += parseInt(m[1], 10);
      if (m[2] !== "-") deletions += parseInt(m[2], 10);
    }
    return { additions, deletions };
  } catch {
    return null;
  }
}

// Best-effort teardown of the throwaway merge worktree. Never throws.
async function removeMergeWorktree(repoPath: string, tmp: string): Promise<void> {
  try {
    await git(repoPath, ["worktree", "remove", "--force", tmp]);
  } catch {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      await git(repoPath, ["worktree", "prune"]);
    } catch {}
  }
}

/**
 * Land `workBranch` into `target` WITHOUT touching the user's main working tree,
 * by doing the merge inside a throwaway linked worktree checked out on `target`.
 * Only valid when `target` is NOT the branch checked out in the main repo (git
 * refuses to check out the same branch in two worktrees) — the caller guarantees
 * that. Because the main tree is never touched, the merge needs no clean-tree
 * check and no branch restore, so it can never strand the user's checkout.
 */
async function mergeIntoTargetWorktree(input: {
  repoPath: string;
  target: string;
  workBranch: string;
  message: string;
  committed: boolean;
  mergedSha?: string;
}): Promise<MergeResult> {
  const { repoPath, target, workBranch, message, committed, mergedSha } = input;
  const tmp = path.join(WORKTREES_DIR, `.merge-${target.replace(/[^A-Za-z0-9._-]/g, "_")}`);
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  // Clear any stale merge worktree left behind by a prior crash before reusing the path.
  await removeMergeWorktree(repoPath, tmp);

  try {
    await git(repoPath, ["worktree", "add", tmp, target]);
  } catch (e) {
    return { ok: false, targetBranch: target, committed, error: `cannot prepare merge worktree for ${target}: ${msgOf(e)}` };
  }

  try {
    await git(tmp, ["merge", "--no-ff", "-m", message, workBranch]);
  } catch (e) {
    const conflicts = (await git(tmp, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""))
      .split("\n")
      .filter(Boolean);
    await git(tmp, ["merge", "--abort"]).catch(() => {});
    await removeMergeWorktree(repoPath, tmp);
    return {
      ok: false,
      targetBranch: target,
      committed,
      conflicts: conflicts.length ? conflicts : undefined,
      error: conflicts.length ? `merge conflicts in ${conflicts.length} file(s)` : `merge failed: ${msgOf(e)}`,
    };
  }

  const stats = await mergeLineStats(tmp);
  await removeMergeWorktree(repoPath, tmp);
  return { ok: true, targetBranch: target, committed, mergedSha, ...(stats ?? {}) };
}

/**
 * Land a task's branch into the base branch. Commits any uncommitted work first,
 * then merges — serialized per repo (see `withRepoLock`) so concurrent merges
 * can't race the main tree's HEAD/index.
 *
 * When the base branch is NOT the one checked out in the main repo, the merge is
 * done in a throwaway worktree so the user's checkout is never touched. When the
 * base branch IS checked out, the merge happens in place in the main tree (which
 * must be clean); a prior crash that stranded that tree mid-merge (MERGE_HEAD
 * set) is recovered with `merge --abort` instead of blocking forever. Conflicts
 * abort cleanly either way.
 */
export async function mergeTask(input: {
  repoPath: string;
  worktreePath: string;
  workBranch: string;
  baseBranch: string;
  message: string;
}): Promise<MergeResult> {
  const { repoPath, worktreePath, workBranch, baseBranch, message } = input;

  let committed = false;
  try {
    committed = await commitWorktree(worktreePath, message);
  } catch (e) {
    return { ok: false, targetBranch: baseBranch, committed, error: `commit failed: ${msgOf(e)}` };
  }

  // The branch tip now holds all of the task's work; this becomes the next diff
  // base so a subsequent round shows only changes made after this merge.
  const mergedSha = (await git(repoPath, ["rev-parse", workBranch]).catch(() => "")) || undefined;

  return withRepoLock(repoPath, async () => {
    // Recover a repo stranded mid-merge by a prior crash: an unfinished merge in
    // the MAIN tree leaves MERGE_HEAD set and the tree "dirty", which would
    // otherwise block EVERY future merge on the dirty check below. Aborting
    // returns it to the pre-merge branch tip — a clean, known state — so merges
    // are never permanently wedged.
    if ((await worktreeMergeStatus(repoPath)).mergeInProgress) {
      await git(repoPath, ["merge", "--abort"]).catch(() => {});
    }

    // Target: the configured base branch if it exists, else the repo's current branch.
    const current = await currentBranch(repoPath);
    const target = (await branchExists(repoPath, baseBranch)) ? baseBranch : current || baseBranch;

    // Nothing to land?
    try {
      const ahead = parseInt(await git(repoPath, ["rev-list", "--count", `${target}..${workBranch}`]), 10) || 0;
      if (ahead === 0) return { ok: true, targetBranch: target, committed, alreadyMerged: true, mergedSha };
    } catch {}

    // Base branch isn't the main checkout → merge in a throwaway worktree so the
    // user's working tree (and its uncommitted edits) are never touched.
    if (target !== current) {
      return mergeIntoTargetWorktree({ repoPath, target, workBranch, message, committed, mergedSha });
    }

    // Base branch IS the main checkout → merge in place. This requires a clean
    // tree, and a failed merge is aborted so we never leave the user mid-merge.
    const dirty = (await git(repoPath, ["status", "--porcelain"]).catch(() => "")).trim().length > 0;
    if (dirty)
      return {
        ok: false,
        targetBranch: target,
        committed,
        error: "the repo's working tree has uncommitted changes — commit or stash them before merging",
      };

    try {
      await git(repoPath, ["merge", "--no-ff", "-m", message, workBranch]);
    } catch (e) {
      const conflicts = (await git(repoPath, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""))
        .split("\n")
        .filter(Boolean);
      await git(repoPath, ["merge", "--abort"]).catch(() => {});
      return {
        ok: false,
        targetBranch: target,
        committed,
        conflicts: conflicts.length ? conflicts : undefined,
        error: conflicts.length ? `merge conflicts in ${conflicts.length} file(s)` : `merge failed: ${msgOf(e)}`,
      };
    }

    const stats = await mergeLineStats(repoPath);
    return { ok: true, targetBranch: target, committed, mergedSha, ...(stats ?? {}) };
  });
}

// ---------- LLM-assisted conflict resolution ----------
//
// When `mergeTask` reports conflicts it aborts in the shared main tree, leaving
// no state to fix. To resolve them, we instead replay the merge the *other*
// direction — base INTO the work branch — but inside the task's ISOLATED
// worktree, leaving the conflict markers in place. Claude (or the user) then
// resolves them there, never touching the shared main tree. Once resolved, the
// work branch contains the base, so `completeWorktreeMerge` lands it cleanly via
// the normal `mergeTask` path.

// A per-worktree ref marking the pre-merge tip of a resolution merge the app
// itself started (via `prepareWorktreeMerge`). `abortWorktreeMerge` uses it to
// undo ONLY that merge — never a merge commit the app didn't create (e.g. a prior
// `sync` of the base branch). Refs under `refs/worktree/` are per-worktree, so
// parallel tasks each get their own marker and never collide on the shared ref
// store. See `abortWorktreeMerge` for the full lifecycle (set here → cleared on
// abort or a successful `completeWorktreeMerge`).
const MERGE_ABORT_REF = "refs/worktree/orch-merge-abort";

async function setMergeAbortMarker(worktreePath: string): Promise<void> {
  await git(worktreePath, ["update-ref", MERGE_ABORT_REF, "HEAD"]).catch(() => {});
}

async function clearMergeAbortMarker(worktreePath: string): Promise<void> {
  await git(worktreePath, ["update-ref", "-d", MERGE_ABORT_REF]).catch(() => {});
}

/** Conflict-resolution state of a task's worktree (survives reloads). */
export interface WorktreeMergeStatus {
  mergeInProgress: boolean; // a merge is paused mid-flight (MERGE_HEAD present)
  unresolved: string[]; // files still flagged unmerged in the index
}

export async function worktreeMergeStatus(worktreePath: string): Promise<WorktreeMergeStatus> {
  if (!worktreePath) return { mergeInProgress: false, unresolved: [] };
  const mergeInProgress = await git(worktreePath, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])
    .then(() => true)
    .catch(() => false);
  const unresolved = (await git(worktreePath, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""))
    .split("\n")
    .filter(Boolean);
  return { mergeInProgress, unresolved };
}

// Of the given unmerged files, those git treats as binary — these can't be
// resolved by editing markers and must be handled manually. During a conflict
// `git diff` emits a *combined* ("--cc") diff, whose --numstat reports 0/0 (not
// '-'/'-') even for binaries, so we instead detect the textual "Binary files
// differ" marker git prints under each file's `diff --cc <path>` header.
async function binaryConflictFiles(worktreePath: string, candidates: string[]): Promise<string[]> {
  if (!candidates.length) return [];
  const out = await git(worktreePath, ["diff", "--diff-filter=U"]).catch(() => "");
  const binary = new Set<string>();
  let current = "";
  for (const line of out.split("\n")) {
    const m = line.match(/^diff --(?:cc|combined) (.+)$/);
    if (m) {
      current = m[1];
    } else if (current && /^Binary files /.test(line)) {
      binary.add(current);
    }
  }
  return candidates.filter((f) => binary.has(f));
}

export interface PrepareMergeResult {
  ok: boolean;
  clean: boolean; // merged with no conflicts (nothing left to resolve)
  conflicts: string[]; // text files with conflicts — resolvable by AI/editor
  binaryConflicts: string[]; // binary/unmergeable files — need manual handling
  error?: string;
}

/**
 * Trial-merge the base branch INTO the task's work branch inside its isolated
 * worktree, leaving conflict markers in place (no abort) so they can be resolved
 * there. Commits any pending worktree edits first. A clean result means the
 * later `completeWorktreeMerge` will land trivially.
 */
export async function prepareWorktreeMerge(input: {
  repoPath: string;
  worktreePath: string;
  baseBranch: string;
  message: string;
}): Promise<PrepareMergeResult> {
  const { repoPath, worktreePath, baseBranch, message } = input;
  const fail = (error: string): PrepareMergeResult => ({ ok: false, clean: false, conflicts: [], binaryConflicts: [], error });
  if (!worktreePath) return fail("this task has no isolated worktree");
  if (!(await branchExists(repoPath, baseBranch))) return fail(`base branch ${baseBranch} not found`);

  // Already mid-merge (e.g. a prior prepare, or a reload) — report its conflicts
  // rather than starting a second merge on top.
  const pre = await worktreeMergeStatus(worktreePath);
  if (pre.mergeInProgress) {
    const binaryConflicts = await binaryConflictFiles(worktreePath, pre.unresolved);
    return { ok: true, clean: false, conflicts: pre.unresolved.filter((f) => !binaryConflicts.includes(f)), binaryConflicts };
  }

  // Commit pending edits so the merge runs against a clean tree.
  try {
    await commitWorktree(worktreePath, message);
  } catch (e) {
    return fail(`commit failed: ${msgOf(e)}`);
  }

  // Record the pre-merge tip so a later `abortWorktreeMerge` can undo strictly the
  // merge we're about to create — and nothing else (see MERGE_ABORT_REF).
  await setMergeAbortMarker(worktreePath);

  try {
    await git(worktreePath, ["merge", "--no-ff", "-m", message, baseBranch]);
    return { ok: true, clean: true, conflicts: [], binaryConflicts: [] };
  } catch {
    const unresolved = (await git(worktreePath, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""))
      .split("\n")
      .filter(Boolean);
    if (!unresolved.length) {
      // Failed for a non-conflict reason — abort to keep the worktree clean.
      await git(worktreePath, ["merge", "--abort"]).catch(() => {});
      await clearMergeAbortMarker(worktreePath);
      return fail("merge failed");
    }
    const binaryConflicts = await binaryConflictFiles(worktreePath, unresolved);
    return { ok: true, clean: false, conflicts: unresolved.filter((f) => !binaryConflicts.includes(f)), binaryConflicts };
  }
}

/**
 * Undo a conflict-resolution merge the app itself started, returning to the
 * pre-merge tip. Deliberately narrow: it will only ever discard a merge recorded
 * by `prepareWorktreeMerge` (the MERGE_ABORT_REF marker) — never a merge commit
 * that happens to sit at HEAD for some other reason (e.g. a `sync` of the base
 * branch), and never over uncommitted edits the app didn't create. When there's
 * nothing the app started to abort, it's a true no-op.
 */
export async function abortWorktreeMerge(worktreePath: string): Promise<void> {
  if (!worktreePath) return;
  const { mergeInProgress } = await worktreeMergeStatus(worktreePath);
  if (mergeInProgress) {
    // A paused merge (MERGE_HEAD present) — `merge --abort` restores the pre-merge
    // tip and working tree atomically. Safe regardless of who started the merge.
    await git(worktreePath, ["merge", "--abort"]).catch(() => {});
    await clearMergeAbortMarker(worktreePath);
    return;
  }

  // No merge is paused. Claude may have committed the resolution merge itself. We
  // undo it ONLY if it's the one the app started — identified by the marker ref at
  // its pre-merge tip. Guessing from HEAD's parent count (the old behaviour) also
  // matched an ordinary sync merge and would `reset --hard` away that commit AND
  // any uncommitted work — real data loss.
  const marker = (await git(worktreePath, ["rev-parse", "-q", "--verify", MERGE_ABORT_REF]).catch(() => "")).trim();
  if (!marker) return; // nothing the app started to abort → no-op

  try {
    // The recorded merge must still be exactly at HEAD: a merge commit whose first
    // parent is the marker. If the worktree has moved on (more commits landed on
    // top), resetting would destroy that later work — so we leave it alone.
    const parents = (await git(worktreePath, ["rev-list", "--parents", "-n", "1", "HEAD"]).catch(() => ""))
      .split(" ")
      .filter(Boolean);
    const isOurMerge = parents.length >= 3 && parents[1] === marker;

    // Never reset over a dirty tree — uncommitted edits made after the merge aren't
    // part of what the app created and must not be silently discarded.
    const dirty = (await git(worktreePath, ["status", "--porcelain"]).catch(() => "")).trim().length > 0;

    if (isOurMerge && !dirty) await git(worktreePath, ["reset", "--hard", marker]).catch(() => {});
  } finally {
    await clearMergeAbortMarker(worktreePath);
  }
}

// ---------- sync the worktree to the latest base branch ----------
//
// An old task's worktree is branched from a stale base_sha; while it sat idle the
// base branch (main) moved on. These helpers drive a divergence-based sync — NOT
// wall-clock age — so a reopened task can be brought up to date before follow-up
// work piles more changes on top of stale code.

export interface SyncStatus {
  behind: number; // commits on the base branch not yet in the work branch
  ahead: number; // divergent commits on the work branch not in the base branch
  isDirty: boolean; // uncommitted changes in the worktree
  canFastForward: boolean; // no divergent work + clean tree → a zero-risk fast-forward
  clean: boolean; // a trial merge of base→work has no conflicts
  conflicts: string[]; // files that would conflict on merge (when not clean)
  baseTip: string; // the base branch tip — the new diff base after a successful sync
}

/**
 * Divergence of a task's work branch versus the base branch, plus a NON-DESTRUCTIVE
 * conflict prediction (via `git merge-tree`) so a banner can show clean-vs-conflicts
 * before the user clicks anything. Read-only: never mutates the worktree.
 */
export async function worktreeSyncStatus(input: {
  repoPath: string;
  worktreePath: string;
  workBranch: string;
  baseBranch: string;
}): Promise<SyncStatus> {
  const { repoPath, worktreePath, workBranch, baseBranch } = input;
  const none: SyncStatus = { behind: 0, ahead: 0, isDirty: false, canFastForward: false, clean: true, conflicts: [], baseTip: "" };
  if (!worktreePath || !workBranch) return none;
  if (!(await branchExists(repoPath, baseBranch)) || !(await branchExists(repoPath, workBranch))) return none;

  const baseTip = await git(repoPath, ["rev-parse", baseBranch]).catch(() => "");
  const countOf = async (range: string) => parseInt(await git(repoPath, ["rev-list", "--count", range]).catch(() => "0"), 10) || 0;
  const behind = await countOf(`${workBranch}..${baseBranch}`);
  const ahead = await countOf(`${baseBranch}..${workBranch}`);
  const isDirty = (await git(worktreePath, ["status", "--porcelain"]).catch(() => "")).trim().length > 0;

  // Already up to date — nothing to sync; skip the (relatively costly) conflict probe.
  if (behind === 0) return { behind, ahead, isDirty, canFastForward: false, clean: true, conflicts: [], baseTip };

  // No divergent commits + clean tree → merging base in is a plain fast-forward
  // (just moves the branch pointer), so there's zero conflict risk.
  if (ahead === 0 && !isDirty) return { behind, ahead, isDirty, canFastForward: true, clean: true, conflicts: [], baseTip };

  const conflicts = await predictMergeConflicts(repoPath, baseBranch, workBranch);
  return { behind, ahead, isDirty, canFastForward: false, clean: conflicts.length === 0, conflicts, baseTip };
}

// Predict the conflicts of merging `baseBranch` into `workBranch` WITHOUT touching
// any worktree, using `git merge-tree --write-tree` (git ≥ 2.38). A clean merge
// exits 0 with just the result tree's OID; a conflicted merge exits non-zero and
// prints the OID, then a "Conflicted file info" block (`<mode> <object> <stage>\t
// <path>` per line) terminated by a blank line. We collect the unique paths there.
// On an unsupported/failed merge-tree we fall back to "clean" — the real merge
// (prepareWorktreeMerge) will still surface any conflicts when the user syncs.
async function predictMergeConflicts(repoPath: string, baseBranch: string, workBranch: string): Promise<string[]> {
  let out: string;
  try {
    await git(repoPath, ["merge-tree", "--write-tree", baseBranch, workBranch]);
    return []; // exit 0 → clean merge
  } catch (e) {
    out = stdoutOf(e);
    if (!out) return []; // merge-tree unsupported or errored — treat as clean
  }
  const lines = out.split("\n");
  const conflicts = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "") break; // end of the conflicted-file-info section
    const tab = lines[i].indexOf("\t");
    if (tab >= 0) conflicts.add(lines[i].slice(tab + 1));
  }
  return [...conflicts];
}

/**
 * Fast-forward the work branch to the base branch inside the worktree. Only safe
 * when there are no divergent commits and the tree is clean (see `canFastForward`);
 * returns false if git refuses the fast-forward.
 */
export async function fastForwardWorktree(worktreePath: string, baseBranch: string): Promise<boolean> {
  try {
    await git(worktreePath, ["merge", "--ff-only", baseBranch]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finish a conflict resolution: stage the resolved files, refuse if any conflict
 * markers remain, commit the merge on the work branch, then land it into the base
 * via the normal `mergeTask` path (now conflict-free).
 */
export async function completeWorktreeMerge(input: {
  repoPath: string;
  worktreePath: string;
  workBranch: string;
  baseBranch: string;
  message: string;
}): Promise<MergeResult> {
  const { repoPath, worktreePath, workBranch, baseBranch, message } = input;
  const { mergeInProgress } = await worktreeMergeStatus(worktreePath);

  // Editing a conflicted file leaves it "unmerged" until staged; stage first so a
  // resolved tree commits cleanly, then scan the staged content for stray markers.
  await git(worktreePath, ["add", "-A"]).catch(() => {});
  const check = await git(worktreePath, ["diff", "--cached", "--check"]).catch((e) => stdoutOf(e));
  if (/conflict marker/i.test(check))
    return {
      ok: false,
      targetBranch: baseBranch,
      committed: false,
      error: "conflict markers (<<<<<<< / =======) still remain — resolve them before merging",
    };

  if (mergeInProgress) {
    try {
      await git(worktreePath, ["commit", "--no-edit", "--no-verify"]);
    } catch {
      await git(worktreePath, [
        "-c", "user.name=Orchestrator", "-c", "user.email=orchestrator@local",
        "commit", "--no-edit", "--no-verify",
      ]);
    }
  }

  const result = await mergeTask({ repoPath, worktreePath, workBranch, baseBranch, message });
  // The resolution merge has landed — its pre-merge marker is spent. Drop it so a
  // subsequent "discard merge" doesn't try to unwind an already-merged commit.
  if (result.ok) await clearMergeAbortMarker(worktreePath);
  return result;
}
