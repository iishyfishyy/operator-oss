import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  branchForTask,
  commitWorktree,
  ensureWorktree,
  isGitRepo,
  mergeTask,
  recentCommits,
  removeWorktree,
  worktreePruneSafety,
} from "../lib/git";
import { WORKTREES_DIR } from "../lib/config";
import { commitFile, git, makeRepo, makeRepoWithWorktree, tmpDir, uid, writeFile } from "./helpers";

describe("isGitRepo", () => {
  it("is true inside a repo and false for plain or missing dirs", async () => {
    const repo = await makeRepo();
    expect(await isGitRepo(repo)).toBe(true);
    expect(await isGitRepo(tmpDir())).toBe(false);
    expect(await isGitRepo(path.join(tmpDir(), "does-not-exist"))).toBe(false);
  });
});

describe("branchForTask", () => {
  it("prefixes the task id", () => {
    expect(branchForTask("abc123")).toBe("orch/abc123");
  });
});

describe("recentCommits", () => {
  it("lists recent commits, newest first", async () => {
    const repo = await makeRepo();
    await commitFile(repo, "a.txt", "a\n", "second commit");
    const log = await recentCommits(repo);
    const lines = log.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/second commit$/);
    expect(lines[1]).toMatch(/initial commit$/);
  });

  it("respects the count limit", async () => {
    const repo = await makeRepo();
    await commitFile(repo, "a.txt", "a\n", "second commit");
    await commitFile(repo, "b.txt", "b\n", "third commit");
    expect((await recentCommits(repo, 2)).split("\n")).toHaveLength(2);
  });

  it("returns empty for non-repos and empty paths", async () => {
    expect(await recentCommits("")).toBe("");
    expect(await recentCommits(tmpDir())).toBe("");
  });
});

describe("ensureWorktree", () => {
  it("creates a worktree + branch from HEAD and reports the base sha", async () => {
    const repo = await makeRepo();
    const head = await git(repo, "rev-parse", "HEAD");
    const taskId = uid();

    const wt = await ensureWorktree(repo, taskId);
    expect(wt).not.toBeNull();
    expect(wt!.path).toBe(path.join(WORKTREES_DIR, taskId));
    expect(wt!.branch).toBe(`orch/${taskId}`);
    expect(wt!.baseSha).toBe(head);

    expect(await isGitRepo(wt!.path)).toBe(true);
    expect(await git(wt!.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`orch/${taskId}`);
    expect(fs.existsSync(path.join(wt!.path, "file.txt"))).toBe(true);
    // The main repo stays on its original branch.
    expect(await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("is idempotent — a second call reuses the existing worktree", async () => {
    const { repo, taskId, wt } = await makeRepoWithWorktree(ensureWorktree);
    const again = await ensureWorktree(repo, taskId);
    expect(again).toEqual(wt);
  });

  it("re-attaches to a surviving branch when the worktree dir was lost", async () => {
    const { repo, taskId, wt } = await makeRepoWithWorktree(ensureWorktree);
    const tip = await commitFile(wt.path, "work.txt", "work\n");
    // Simulate the dir vanishing (machine cleanup) while the branch survives.
    await git(repo, "worktree", "remove", "--force", wt.path);
    expect(await git(repo, "rev-parse", `refs/heads/${wt.branch}`)).toBe(tip);

    const again = await ensureWorktree(repo, taskId);
    expect(again!.path).toBe(wt.path);
    expect(await git(again!.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(wt.branch);
    expect(await git(again!.path, "rev-parse", "HEAD")).toBe(tip);
  });

  it("initializes a non-git directory (greenfield project) before isolating", async () => {
    const dir = tmpDir("greenfield-");
    writeFile(dir, "app.js", "console.log('hi')\n");

    const wt = await ensureWorktree(dir, uid());
    expect(wt).not.toBeNull();
    expect(await isGitRepo(dir)).toBe(true);
    // Baseline commit captured the existing file and a default .gitignore.
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(true);
    expect(fs.existsSync(path.join(wt!.path, "app.js"))).toBe(true);
    expect(await git(dir, "log", "--format=%s")).toBe("Initial project state (orchestrator)");
  });

  it("makes a baseline commit in a repo with no commits", async () => {
    const dir = tmpDir("empty-repo-");
    await git(dir, "init", "-b", "main");
    writeFile(dir, "notes.md", "hello\n");

    const wt = await ensureWorktree(dir, uid());
    expect(wt).not.toBeNull();
    expect(wt!.baseSha).toBe(await git(dir, "rev-parse", "HEAD"));
    expect(fs.existsSync(path.join(wt!.path, "notes.md"))).toBe(true);
  });
});

describe("removeWorktree", () => {
  it("removes the worktree directory, registration and branch", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await removeWorktree(repo, wt.path, wt.branch);

    expect(fs.existsSync(wt.path)).toBe(false);
    expect(await git(repo, "worktree", "list")).not.toContain(wt.path);
    await expect(git(repo, "rev-parse", "--verify", `refs/heads/${wt.branch}`)).rejects.toThrow();
  });

  it("falls back to prune + branch delete when the worktree dir is already gone", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    // Simulate the dir being deleted out from under git (external cleanup): the
    // registration goes stale, so `git worktree remove` errors and the catch
    // branch (rmSync + prune) is what actually cleans up.
    fs.rmSync(wt.path, { recursive: true, force: true });

    await removeWorktree(repo, wt.path, wt.branch);
    expect(await git(repo, "worktree", "list")).not.toContain(wt.path);
    await expect(git(repo, "rev-parse", "--verify", `refs/heads/${wt.branch}`)).rejects.toThrow();
  });

  it("never throws, even with bogus inputs", async () => {
    const repo = await makeRepo();
    await expect(removeWorktree(repo, "/nonexistent/worktree", "no-such-branch")).resolves.toBeUndefined();
    await expect(removeWorktree(repo, "", "")).resolves.toBeUndefined();
    await expect(removeWorktree("/not/a/repo", "/nonexistent/worktree", "x")).resolves.toBeUndefined();
  });
});

describe("worktreePruneSafety", () => {
  const safetyOf = (repo: string, wt: { path: string; branch: string }) =>
    worktreePruneSafety({ repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main" });

  it("a clean, fully-merged worktree is safe to prune", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "feature.txt", "feature\n", "task commit");
    const res = await mergeTask({ repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main", message: "land" });
    expect(res.ok).toBe(true);

    const safety = await safetyOf(repo, wt);
    expect(safety).toMatchObject({ safe: true, isDirty: false, ahead: 0 });
  });

  it("flags uncommitted changes made after a merge as unsafe", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "feature.txt", "feature\n", "task commit");
    await mergeTask({ repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main", message: "land" });
    // Round-2 edit left uncommitted — force-remove would silently discard it.
    writeFile(wt.path, "feature.txt", "round two edit\n");

    const safety = await safetyOf(repo, wt);
    expect(safety.safe).toBe(false);
    expect(safety.isDirty).toBe(true);
    expect(safety.reason).toBeTruthy();
  });

  it("flags committed-but-unmerged commits made after a merge as unsafe", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "feature.txt", "feature\n", "task commit");
    await mergeTask({ repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main", message: "land" });
    // Round-2 commit never merged — branch -D would orphan it.
    await commitFile(wt.path, "feature.txt", "round two\n", "round two commit");

    const safety = await safetyOf(repo, wt);
    expect(safety.safe).toBe(false);
    expect(safety.ahead).toBe(1);
    expect(safety.reason).toContain("main");
  });

  it("treats a missing worktree path as safe (nothing to lose)", async () => {
    const repo = await makeRepo();
    const safety = await worktreePruneSafety({ repoPath: repo, worktreePath: "", workBranch: "", baseBranch: "main" });
    expect(safety).toMatchObject({ safe: true, isDirty: false, ahead: 0 });
  });
});

describe("commitWorktree", () => {
  it("returns false when there is nothing to commit", async () => {
    const { wt } = await makeRepoWithWorktree(ensureWorktree);
    expect(await commitWorktree(wt.path, "noop")).toBe(false);
  });

  it("stages and commits all changes (modified + untracked)", async () => {
    const { wt } = await makeRepoWithWorktree(ensureWorktree);
    writeFile(wt.path, "file.txt", "changed\n");
    writeFile(wt.path, "new-dir/new.txt", "new\n");

    expect(await commitWorktree(wt.path, "task work")).toBe(true);
    expect(await git(wt.path, "status", "--porcelain")).toBe("");
    expect(await git(wt.path, "log", "-1", "--format=%s")).toBe("task work");
  });

  it("commits with a fallback identity when none is configured", async () => {
    const { wt } = await makeRepoWithWorktree(ensureWorktree);
    writeFile(wt.path, "file.txt", "no identity\n");

    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = "/dev/null"; // strip the test identity
    try {
      expect(await commitWorktree(wt.path, "identity-less commit")).toBe(true);
    } finally {
      process.env.GIT_CONFIG_GLOBAL = saved;
    }
    expect(await git(wt.path, "log", "-1", "--format=%s")).toBe("identity-less commit");
  });
});
