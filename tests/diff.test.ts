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

  it("maps patches to files across renames and c-quoted/space-containing paths", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "dir with space/sp aced.txt", "hello\nworld\n", "spaced");
    await commitFile(wt.path, "uni cödé.txt", "ünï\n", "unicode"); // git c-quotes this in diff headers
    await commitFile(wt.path, "old-name.txt", "same content\n", "to rename");
    const baseSha = await git(wt.path, "rev-parse", "HEAD");

    writeFile(wt.path, "dir with space/sp aced.txt", "hello\nthere\nworld\n");
    writeFile(wt.path, "uni cödé.txt", "ünï\nmore\n");
    await git(wt.path, "mv", "old-name.txt", "new name ö.txt");
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "-m", "edits", "--no-verify");

    const diff = await taskDiff(repo, wt.path, baseSha, "main");
    const byPath = new Map(diff.files.map((f) => [f.path, f]));

    const spaced = byPath.get("dir with space/sp aced.txt")!;
    expect(spaced.patch).toContain("+there");
    expect(spaced.additions).toBe(1);

    const unicode = byPath.get("uni cödé.txt")!; // raw path, not git's c-quoted form
    expect(unicode.patch).toContain("+more");
    expect(unicode.patch).toContain('"a/uni c\\303\\266d\\303\\251.txt"');

    const renamed = byPath.get("new name ö.txt")!;
    expect(renamed.status).toBe("R");
    expect(renamed.patch).toContain("rename from old-name.txt");
  });

  it("synthesizes untracked patches like git (exec bit, empty file, no trailing newline)", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    writeFile(wt.path, "exec.sh", "#!/bin/sh\necho hi\n");
    fs.chmodSync(path.join(wt.path, "exec.sh"), 0o755);
    writeFile(wt.path, "no-nl.txt", "no newline at end");
    writeFile(wt.path, "empty.txt", "");

    const diff = await taskDiff(repo, wt.path, wt.baseSha, "main");
    const byPath = new Map(diff.files.map((f) => [f.path, f]));

    const exec = byPath.get("exec.sh")!;
    expect(exec.patch).toContain("new file mode 100755");
    expect(exec.patch).toContain("@@ -0,0 +1,2 @@");
    expect(exec.additions).toBe(2);

    const noNl = byPath.get("no-nl.txt")!;
    expect(noNl.patch).toContain("@@ -0,0 +1 @@");
    expect(noNl.patch).toContain("\\ No newline at end of file");
    expect(noNl.additions).toBe(1);

    const empty = byPath.get("empty.txt")!;
    expect(empty.additions).toBe(0);
    expect(empty.patch).toBe("diff --git a/empty.txt b/empty.txt\nnew file mode 100644");
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
