import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  abortWorktreeMerge,
  completeWorktreeMerge,
  ensureWorktree,
  mergeTask,
  prepareWorktreeMerge,
  worktreeMergeStatus,
} from "../lib/git";
import { commitFile, git, makeRepo, makeRepoWithWorktree, uid, writeFile } from "./helpers";

const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf8");

describe("mergeTask", () => {
  it("commits pending work and lands it on the base branch", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    writeFile(wt.path, "feature.txt", "feature\n"); // left uncommitted on purpose

    const res = await mergeTask({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "main",
      message: "land feature",
    });

    expect(res.ok).toBe(true);
    expect(res.committed).toBe(true);
    expect(res.targetBranch).toBe("main");
    expect(res.alreadyMerged).toBeUndefined();
    expect(res.mergedSha).toBe(await git(repo, "rev-parse", wt.branch));
    // main got the file via a merge commit; the repo stays on main.
    expect(read(repo, "feature.txt")).toBe("feature\n");
    expect(await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(await git(repo, "log", "-1", "--format=%s", "main")).toBe("land feature");
  });

  it("restores the branch the repo had checked out", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "feature.txt", "feature\n", "task commit");
    await git(repo, "checkout", "-b", "scratch");

    const res = await mergeTask({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "main",
      message: "land feature",
    });

    expect(res.ok).toBe(true);
    expect(res.targetBranch).toBe("main");
    expect(await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("scratch");
    expect(await git(repo, "log", "-1", "--format=%s", "main")).toBe("land feature");
  });

  it("short-circuits when there is nothing to land", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    const res = await mergeTask({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "main",
      message: "noop",
    });
    expect(res.ok).toBe(true);
    expect(res.alreadyMerged).toBe(true);
    expect(res.committed).toBe(false);
  });

  it("refuses when the main working tree is dirty", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "feature.txt", "feature\n", "task commit");
    writeFile(repo, "file.txt", "local edit\n"); // dirty the main tree

    const res = await mergeTask({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "main",
      message: "land feature",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/uncommitted changes/);
    // The local edit was not clobbered.
    expect(read(repo, "file.txt")).toBe("local edit\n");
  });

  it("aborts cleanly on conflicts, listing the conflicted files", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "file.txt", "task version\n", "task edit");
    await commitFile(repo, "file.txt", "main version\n", "main edit");
    const mainTip = await git(repo, "rev-parse", "main");

    const res = await mergeTask({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "main",
      message: "land feature",
    });

    expect(res.ok).toBe(false);
    expect(res.conflicts).toEqual(["file.txt"]);
    expect(res.error).toMatch(/conflicts in 1 file/);
    // The merge was aborted: main untouched, tree clean, no merge in progress.
    expect(await git(repo, "rev-parse", "main")).toBe(mainTip);
    expect(await git(repo, "status", "--porcelain")).toBe("");
    expect((await worktreeMergeStatus(repo)).mergeInProgress).toBe(false);
  });

  it("serializes two concurrent merges on the same repo", async () => {
    const repo = await makeRepo();
    const a = await ensureWorktree(repo, uid());
    const b = await ensureWorktree(repo, uid());
    if (!a || !b) throw new Error("ensureWorktree returned null");
    await commitFile(a.path, "a.txt", "a\n", "task a");
    await commitFile(b.path, "b.txt", "b\n", "task b");

    const [ra, rb] = await Promise.all([
      mergeTask({ repoPath: repo, worktreePath: a.path, workBranch: a.branch, baseBranch: "main", message: "land a" }),
      mergeTask({ repoPath: repo, worktreePath: b.path, workBranch: b.branch, baseBranch: "main", message: "land b" }),
    ]);

    // Both land cleanly (serialized), and the repo is left on the original branch
    // with both tasks' files present on main.
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    expect(await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(read(repo, "a.txt")).toBe("a\n");
    expect(read(repo, "b.txt")).toBe("b\n");
    expect(await git(repo, "status", "--porcelain")).toBe("");
  });

  it("recovers a repo stranded mid-merge by a prior crash", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "feature.txt", "feature\n", "task commit");

    // Strand the MAIN tree mid-merge (as a crash would): two branches edit the
    // same file, so `git merge` stops with MERGE_HEAD set and a dirty index.
    await git(repo, "checkout", "-b", "other");
    await commitFile(repo, "file.txt", "other version\n", "other edit");
    await git(repo, "checkout", "main");
    await commitFile(repo, "file.txt", "main version\n", "main edit");
    await git(repo, "merge", "other").catch(() => {}); // conflicts → stranded MERGE_HEAD
    expect((await worktreeMergeStatus(repo)).mergeInProgress).toBe(true);

    // The next merge recovers the stranded tree instead of blocking on it forever.
    const res = await mergeTask({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "main",
      message: "land feature",
    });

    expect(res.ok).toBe(true);
    expect((await worktreeMergeStatus(repo)).mergeInProgress).toBe(false);
    expect(await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(read(repo, "feature.txt")).toBe("feature\n");
  });

  it("merges into a base branch that is not the main checkout without touching the working tree", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "feature.txt", "feature\n", "task commit");
    // Put the main tree on a different branch with its own uncommitted edit.
    await git(repo, "checkout", "-b", "scratch");
    writeFile(repo, "scratch.txt", "local wip\n");

    const res = await mergeTask({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "main",
      message: "land feature",
    });

    expect(res.ok).toBe(true);
    expect(res.targetBranch).toBe("main");
    // main advanced, main tree stayed on scratch with its uncommitted edit intact.
    expect(await git(repo, "log", "-1", "--format=%s", "main")).toBe("land feature");
    expect(await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("scratch");
    expect(read(repo, "scratch.txt")).toBe("local wip\n");
    expect(fs.existsSync(path.join(repo, "feature.txt"))).toBe(false);
  });

  it("falls back to the current branch when the base branch is missing", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "feature.txt", "feature\n", "task commit");

    const res = await mergeTask({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "develop", // does not exist
      message: "land feature",
    });
    expect(res.ok).toBe(true);
    expect(res.targetBranch).toBe("main");
    expect(read(repo, "feature.txt")).toBe("feature\n");
  });
});

describe("prepareWorktreeMerge", () => {
  it("merges a non-conflicting base advance cleanly into the worktree", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "task.txt", "task\n", "task edit");
    await commitFile(repo, "main.txt", "main\n", "main moved on");

    const res = await prepareWorktreeMerge({
      repoPath: repo,
      worktreePath: wt.path,
      baseBranch: "main",
      message: "sync base",
    });

    expect(res).toEqual({ ok: true, clean: true, conflicts: [], binaryConflicts: [] });
    expect(read(wt.path, "main.txt")).toBe("main\n"); // base content arrived
    expect((await worktreeMergeStatus(wt.path)).mergeInProgress).toBe(false);
  });

  it("leaves conflict markers in place and reports text vs binary conflicts", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(repo, "blob.bin", Buffer.from([0, 1, 2, 3]), "add binary");
    // Re-branch the worktree off the binary-bearing commit so both sides can edit it.
    await git(wt.path, "reset", "--hard", "main");
    await commitFile(wt.path, "file.txt", "task version\n", "task text edit");
    await commitFile(wt.path, "blob.bin", Buffer.from([0, 9, 9, 9]), "task binary edit");
    await commitFile(repo, "file.txt", "main version\n", "main text edit");
    await commitFile(repo, "blob.bin", Buffer.from([0, 7, 7, 7]), "main binary edit");

    const res = await prepareWorktreeMerge({
      repoPath: repo,
      worktreePath: wt.path,
      baseBranch: "main",
      message: "sync base",
    });

    expect(res.ok).toBe(true);
    expect(res.clean).toBe(false);
    expect(res.conflicts).toEqual(["file.txt"]);
    expect(res.binaryConflicts).toEqual(["blob.bin"]);
    expect(read(wt.path, "file.txt")).toContain("<<<<<<<");

    const status = await worktreeMergeStatus(wt.path);
    expect(status.mergeInProgress).toBe(true);
    expect(status.unresolved.sort()).toEqual(["blob.bin", "file.txt"]);
  });

  it("reports the existing conflicts when a merge is already in progress", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "file.txt", "task version\n", "task edit");
    await commitFile(repo, "file.txt", "main version\n", "main edit");
    const input = { repoPath: repo, worktreePath: wt.path, baseBranch: "main", message: "sync" };

    const first = await prepareWorktreeMerge(input);
    expect(first.clean).toBe(false);
    const second = await prepareWorktreeMerge(input);
    expect(second).toEqual({ ok: true, clean: false, conflicts: ["file.txt"], binaryConflicts: [] });
  });

  it("fails up front without a worktree or with a missing base branch", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    const noWt = await prepareWorktreeMerge({ repoPath: repo, worktreePath: "", baseBranch: "main", message: "m" });
    expect(noWt.ok).toBe(false);
    expect(noWt.error).toMatch(/no isolated worktree/);

    const noBase = await prepareWorktreeMerge({ repoPath: repo, worktreePath: wt.path, baseBranch: "develop", message: "m" });
    expect(noBase.ok).toBe(false);
    expect(noBase.error).toMatch(/develop not found/);
  });
});

describe("conflict resolution: complete / abort", () => {
  // Shared fixture: prepare() has paused mid-merge with a conflict in file.txt.
  async function conflictedWorktree() {
    const fx = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(fx.wt.path, "file.txt", "task version\n", "task edit");
    await commitFile(fx.repo, "file.txt", "main version\n", "main edit");
    const res = await prepareWorktreeMerge({
      repoPath: fx.repo,
      worktreePath: fx.wt.path,
      baseBranch: "main",
      message: "sync base",
    });
    expect(res.clean).toBe(false);
    return fx;
  }

  it("completeWorktreeMerge refuses while conflict markers remain", async () => {
    const { repo, wt } = await conflictedWorktree();
    const res = await completeWorktreeMerge({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "main",
      message: "land",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/conflict markers/);
    expect((await worktreeMergeStatus(wt.path)).mergeInProgress).toBe(true); // still resumable
  });

  it("completeWorktreeMerge lands a resolved conflict into the base branch", async () => {
    const { repo, wt } = await conflictedWorktree();
    writeFile(wt.path, "file.txt", "resolved version\n");

    const res = await completeWorktreeMerge({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "main",
      message: "land resolved",
    });

    expect(res.ok).toBe(true);
    expect(res.mergedSha).toBe(await git(repo, "rev-parse", wt.branch));
    expect(read(repo, "file.txt")).toBe("resolved version\n");
    expect((await worktreeMergeStatus(wt.path)).mergeInProgress).toBe(false);
  });

  it("completeWorktreeMerge after a clean prepare is a plain landing", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "task.txt", "task\n", "task edit");
    await commitFile(repo, "main.txt", "main\n", "main moved on");
    const prep = await prepareWorktreeMerge({ repoPath: repo, worktreePath: wt.path, baseBranch: "main", message: "sync" });
    expect(prep.clean).toBe(true);

    const res = await completeWorktreeMerge({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "main",
      message: "land",
    });
    expect(res.ok).toBe(true);
    expect(read(repo, "task.txt")).toBe("task\n");
  });

  it("abortWorktreeMerge cancels an in-progress merge", async () => {
    const { wt } = await conflictedWorktree();
    const preMergeTip = await git(wt.path, "rev-parse", "HEAD");

    await abortWorktreeMerge(wt.path);

    expect((await worktreeMergeStatus(wt.path)).mergeInProgress).toBe(false);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(preMergeTip);
    expect(read(wt.path, "file.txt")).toBe("task version\n"); // markers gone
    expect(await git(wt.path, "status", "--porcelain")).toBe("");
  });

  it("abortWorktreeMerge unwinds a merge Claude already committed", async () => {
    const { wt } = await conflictedWorktree();
    const preMergeTip = await git(wt.path, "rev-parse", "HEAD");
    // Resolve and commit the merge by hand — MERGE_HEAD is consumed.
    writeFile(wt.path, "file.txt", "resolved\n");
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--no-edit", "--no-verify");
    expect((await worktreeMergeStatus(wt.path)).mergeInProgress).toBe(false);

    await abortWorktreeMerge(wt.path);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(preMergeTip);
  });

  it("abortWorktreeMerge never discards ordinary, non-merge commits", async () => {
    const { wt } = await makeRepoWithWorktree(ensureWorktree);
    const tip = await commitFile(wt.path, "work.txt", "work\n", "ordinary commit");

    await abortWorktreeMerge(wt.path);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(tip);
  });

  it("abortWorktreeMerge spares a prior sync merge commit + uncommitted work", async () => {
    // Reproduces the P1 data-loss bug: HEAD is an EARLIER merge commit the app did
    // not create for conflict resolution (e.g. a sync of main), and the agent has
    // since made uncommitted edits. "Discard merge" must be a no-op here.
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "task.txt", "task\n", "task edit");
    await commitFile(repo, "main.txt", "main\n", "main moved on");
    // Sync main into the work branch — HEAD becomes a (non-resolution) merge commit.
    await git(wt.path, "merge", "--no-ff", "-m", "sync main", "main");
    const syncMerge = await git(wt.path, "rev-parse", "HEAD");
    // Agent edits a file but does not commit.
    writeFile(wt.path, "task.txt", "task WIP edit\n");

    await abortWorktreeMerge(wt.path);

    // Neither the sync merge commit nor the uncommitted edit was destroyed.
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(syncMerge);
    expect(read(wt.path, "task.txt")).toBe("task WIP edit\n");
  });

  it("abortWorktreeMerge unwinds a resolution merge but keeps unrelated later work", async () => {
    // A genuine app-started resolution merge is committed, then MORE commits land on
    // top. Abort must not blow away that later work — it only owns the merge it made.
    const { repo, wt } = await conflictedWorktree();
    const preMergeTip = await git(wt.path, "rev-parse", "HEAD");
    writeFile(wt.path, "file.txt", "resolved\n");
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--no-edit", "--no-verify"); // the resolution merge
    const later = await commitFile(wt.path, "more.txt", "more\n", "follow-up work");

    await abortWorktreeMerge(wt.path);

    // HEAD unchanged: the merge is buried under `later`, no longer safe to discard.
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(later);
    expect(later).not.toBe(preMergeTip);
    expect(await git(repo, "rev-parse", "HEAD")).toBeTruthy();
  });

  it("worktreeMergeStatus and abortWorktreeMerge tolerate an empty path", async () => {
    expect(await worktreeMergeStatus("")).toEqual({ mergeInProgress: false, unresolved: [] });
    await expect(abortWorktreeMerge("")).resolves.toBeUndefined();
  });
});
