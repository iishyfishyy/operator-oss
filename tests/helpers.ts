import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const exec = promisify(execFile);

/** Run a git command in `cwd`, returning trimmed stdout. Throws on non-zero exit. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

/** Fresh directory under the per-run tmp root (cleaned up by tests/setup.ts). */
export function tmpDir(prefix = "dir-"): string {
  return fs.mkdtempSync(path.join(process.env.ORCH_TEST_TMP!, prefix));
}

export const uid = () => crypto.randomBytes(6).toString("hex");

export function writeFile(repo: string, file: string, content: string | Buffer): void {
  const p = path.join(repo, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

export async function commitFile(
  repo: string,
  file: string,
  content: string | Buffer,
  message = `update ${file}`
): Promise<string> {
  writeFile(repo, file, content);
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", message, "--no-verify");
  return git(repo, "rev-parse", "HEAD");
}

/** New repo on `main` with one initial commit (file.txt). */
export async function makeRepo(): Promise<string> {
  const repo = tmpDir("repo-");
  await git(repo, "init", "-b", "main");
  await commitFile(repo, "file.txt", "line one\nline two\n", "initial commit");
  return repo;
}

/** Repo + task worktree via ensureWorktree, with the boilerplate unpacked. */
export async function makeRepoWithWorktree(ensureWorktree: (repoPath: string, taskId: string) => Promise<{ path: string; branch: string; baseSha: string } | null>) {
  const repo = await makeRepo();
  const taskId = uid();
  const wt = await ensureWorktree(repo, taskId);
  if (!wt) throw new Error("ensureWorktree returned null in fixture");
  return { repo, taskId, wt };
}
