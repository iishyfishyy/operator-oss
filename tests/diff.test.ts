import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureWorktree, mergeTask, taskDiff } from "../lib/git";
import { commitFile, git, makeRepoWithWorktree, writeFile } from "./helpers";

describe("taskDiff", () => {
  it("reports a clean, up-to-date worktree as empty", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    const diff = await taskDiff(repo, wt.path, wt.baseSha, "main");

    expect(diff.base).toBe(wt.baseSha);
    expect(diff.baseLabel).toBe("main");
    expect(diff.files).toEqual([]);
    expect(diff.isDirty).toBe(false);
    expect(diff.ahead).toBe(0);
    // HEAD == main tip, so technically already reachable from main.
    expect(diff.alreadyMerged).toBe(true);
  });

  it("captures modified, deleted and untracked files with stats and patches", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "doomed.txt", "bye\n", "add doomed file");
    const baseSha = await git(wt.path, "rev-parse", "HEAD"); // rebase the fixture's base

    writeFile(wt.path, "file.txt", "line one\nline two\nline three\n"); // modify tracked
    fs.rmSync(path.join(wt.path, "doomed.txt")); // delete tracked
    writeFile(wt.path, "brand-new.txt", "a\nb\nc\n"); // untracked

    const diff = await taskDiff(repo, wt.path, baseSha, "main");
    const byPath = new Map(diff.files.map((f) => [f.path, f]));

    const modified = byPath.get("file.txt")!;
    expect(modified.status).toBe("M");
    expect(modified.additions).toBe(1);
    expect(modified.deletions).toBe(0);
    expect(modified.patch).toContain("+line three");

    const deleted = byPath.get("doomed.txt")!;
    expect(deleted.status).toBe("D");
    expect(deleted.deletions).toBe(1);

    const untracked = byPath.get("brand-new.txt")!;
    expect(untracked.status).toBe("?");
    expect(untracked.additions).toBe(3);
    expect(untracked.deletions).toBe(0);
    expect(untracked.binary).toBe(false);
    expect(untracked.patch).toContain("+a");

    expect(diff.files).toHaveLength(3);
    expect(diff.isDirty).toBe(true);
    expect(diff.ahead).toBe(0); // nothing committed beyond the base yet
    expect(diff.alreadyMerged).toBe(false); // worktree committed past main
  });

  it("counts committed work as ahead and not dirty", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "feature.txt", "feature\n", "feature commit");

    const diff = await taskDiff(repo, wt.path, wt.baseSha, "main");
    expect(diff.ahead).toBe(1);
    expect(diff.isDirty).toBe(false);
    expect(diff.alreadyMerged).toBe(false);
    expect(diff.files.map((f) => f.path)).toEqual(["feature.txt"]);
    expect(diff.files[0].status).toBe("A");
  });

  it("flags untracked binary files without counting lines", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    writeFile(wt.path, "blob.bin", Buffer.from([0, 1, 2, 0, 255, 0, 7]));

    const diff = await taskDiff(repo, wt.path, wt.baseSha, "main");
    const bin = diff.files.find((f) => f.path === "blob.bin")!;
    expect(bin.status).toBe("?");
    expect(bin.binary).toBe(true);
    expect(bin.additions).toBe(0);
  });

  it("truncates oversized per-file patches", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    writeFile(wt.path, "huge.txt", "x".repeat(40).concat("\n").repeat(2000)); // ~82k chars

    const diff = await taskDiff(repo, wt.path, wt.baseSha, "main");
    const huge = diff.files.find((f) => f.path === "huge.txt")!;
    expect(huge.truncated).toBe(true);
    expect(huge.patch.length).toBeLessThanOrEqual(60_000);
  });

  it("falls back to the merge-base when the stored base sha is gone", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "work.txt", "work\n", "task commit");

    const diff = await taskDiff(repo, wt.path, "0123456789abcdef0123456789abcdef01234567", "main");
    expect(diff.base).toBe(wt.baseSha); // merge-base(main, HEAD) is where we branched
    expect(diff.files.map((f) => f.path)).toEqual(["work.txt"]);
  });

  it("falls back to the root commit when neither base sha nor branch is usable", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    const root = await git(wt.path, "rev-list", "--max-parents=0", "HEAD");

    const diff = await taskDiff(repo, wt.path, "", "");
    expect(diff.base).toBe(root);
    expect(diff.baseLabel).toBe(root.slice(0, 7));
    expect(diff.alreadyMerged).toBe(false); // no base branch to compare against
  });

  it("detects work merged outside the app as alreadyMerged", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "done.txt", "done\n", "task commit");
    const merged = await mergeTask({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "main",
      message: "land task",
    });
    expect(merged.ok).toBe(true);

    const diff = await taskDiff(repo, wt.path, wt.baseSha, "main");
    expect(diff.alreadyMerged).toBe(true);
    expect(diff.ahead).toBeGreaterThan(0); // commits exist, but all reachable from main
  });
});
