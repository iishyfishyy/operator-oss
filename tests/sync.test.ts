import { describe, expect, it } from "vitest";
import { ensureWorktree, fastForwardWorktree, worktreeSyncStatus } from "../lib/git";
import { commitFile, git, makeRepoWithWorktree, tmpDir, writeFile } from "./helpers";

describe("worktreeSyncStatus", () => {
  it("reports an up-to-date branch with nothing to do", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    const s = await worktreeSyncStatus({ repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main" });
    expect(s).toEqual({
      behind: 0,
      ahead: 0,
      isDirty: false,
      canFastForward: false,
      clean: true,
      conflicts: [],
      baseTip: await git(repo, "rev-parse", "main"),
    });
  });

  it("offers a fast-forward when only the base moved and the tree is clean", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    const baseTip = await commitFile(repo, "main.txt", "main\n", "base advance");

    const s = await worktreeSyncStatus({ repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main" });
    expect(s.behind).toBe(1);
    expect(s.ahead).toBe(0);
    expect(s.isDirty).toBe(false);
    expect(s.canFastForward).toBe(true);
    expect(s.clean).toBe(true);
    expect(s.baseTip).toBe(baseTip);
  });

  it("withholds the fast-forward when the tree is dirty", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(repo, "main.txt", "main\n", "base advance");
    writeFile(wt.path, "scratch.txt", "uncommitted\n");

    const s = await worktreeSyncStatus({ repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main" });
    expect(s.behind).toBe(1);
    expect(s.isDirty).toBe(true);
    expect(s.canFastForward).toBe(false);
    expect(s.clean).toBe(true); // branches themselves merge cleanly
  });

  it("predicts a clean merge for non-overlapping divergence", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "task.txt", "task\n", "task edit");
    await commitFile(repo, "main.txt", "main\n", "main edit");

    const s = await worktreeSyncStatus({ repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main" });
    expect(s.behind).toBe(1);
    expect(s.ahead).toBe(1);
    expect(s.canFastForward).toBe(false);
    expect(s.clean).toBe(true);
    expect(s.conflicts).toEqual([]);
  });

  it("predicts conflicts for overlapping divergence, without touching the worktree", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "file.txt", "task version\n", "task edit");
    await commitFile(repo, "file.txt", "main version\n", "main edit");
    const wtTip = await git(wt.path, "rev-parse", "HEAD");

    const s = await worktreeSyncStatus({ repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main" });
    expect(s.behind).toBe(1);
    expect(s.ahead).toBe(1);
    expect(s.clean).toBe(false);
    expect(s.conflicts).toEqual(["file.txt"]);
    // Read-only: no merge started, no files changed, tip unmoved.
    expect(await git(wt.path, "status", "--porcelain")).toBe("");
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(wtTip);
  });

  it("returns the inert status when the base branch was deleted", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await git(repo, "checkout", "-b", "scratch");
    await git(repo, "branch", "-D", "main");

    const s = await worktreeSyncStatus({ repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main" });
    expect(s).toEqual({ behind: 0, ahead: 0, isDirty: false, canFastForward: false, clean: true, conflicts: [], baseTip: "" });
  });

  it("returns the inert status for missing worktree/branch inputs", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    const none = { behind: 0, ahead: 0, isDirty: false, canFastForward: false, clean: true, conflicts: [], baseTip: "" };
    expect(await worktreeSyncStatus({ repoPath: repo, worktreePath: "", workBranch: wt.branch, baseBranch: "main" })).toEqual(none);
    expect(await worktreeSyncStatus({ repoPath: repo, worktreePath: wt.path, workBranch: "", baseBranch: "main" })).toEqual(none);
    expect(await worktreeSyncStatus({ repoPath: repo, worktreePath: wt.path, workBranch: "orch/ghost", baseBranch: "main" })).toEqual(none);
  });
});

describe("fastForwardWorktree", () => {
  it("advances the work branch to the base tip", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    const baseTip = await commitFile(repo, "main.txt", "main\n", "base advance");

    expect(await fastForwardWorktree(wt.path, "main")).toBe(true);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(baseTip);
    expect(await git(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(wt.branch); // still on the work branch
  });

  it("refuses when the branches diverged", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "task.txt", "task\n", "task edit");
    await commitFile(repo, "main.txt", "main\n", "main edit");
    const wtTip = await git(wt.path, "rev-parse", "HEAD");

    expect(await fastForwardWorktree(wt.path, "main")).toBe(false);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(wtTip);
  });

  it("refuses when dirty files would be overwritten", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(repo, "file.txt", "main version\n", "base advance");
    writeFile(wt.path, "file.txt", "uncommitted local edit\n");
    const wtTip = await git(wt.path, "rev-parse", "HEAD");

    expect(await fastForwardWorktree(wt.path, "main")).toBe(false);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(wtTip);
  });

  it("returns false for a directory that is not a git repo", async () => {
    expect(await fastForwardWorktree(tmpDir(), "main")).toBe(false);
  });
});
