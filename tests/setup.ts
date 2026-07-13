import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// This file runs before each test file's module graph is loaded, so env set
// here is seen by lib/config.ts (which reads ORCH_WORKTREES_DIR at import time).

// realpathSync: os.tmpdir() is a symlink on macOS (/var -> /private/var) and git
// reports realpaths, so resolve it up front to keep path comparisons exact.
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-git-test-"));
process.env.ORCH_TEST_TMP = root;
process.env.ORCH_WORKTREES_DIR = path.join(root, "worktrees");
// Point the SQLite store at a throwaway dir so store-backed tests get a fresh,
// isolated orchestrator.db instead of the user's real one. Read at import time
// by lib/config.ts, so it must be set here (before the module graph loads).
process.env.ORCH_DB_DIR = path.join(root, "db");

// Control plane v2: isolate its SQLite db and pin the seams to their in-process
// mocks. Set here (before the module graph loads) so lib/control-plane/config.ts
// reads ORCH_CP_DB_DIR at import time and cpDb() opens the throwaway file.
process.env.ORCH_CP_DB_DIR = path.join(root, "cp-db");
process.env.ORCH_PROVISIONER = "mock";
process.env.ORCH_BILLING_PROVIDER = "mock";

// Hermetic git: pin all config to a file we control so the suite never depends
// on (or mutates) the user's identity, hooks, signing, or default-branch setup.
const gitconfig = path.join(root, "gitconfig");
fs.writeFileSync(
  gitconfig,
  [
    "[user]",
    "\tname = Orchestrator Test",
    "\temail = test@orchestrator.local",
    "[init]",
    "\tdefaultBranch = main",
    "[commit]",
    "\tgpgsign = false",
    "[core]",
    `\thooksPath = ${path.join(root, "no-hooks")}`,
    "",
  ].join("\n")
);
process.env.GIT_CONFIG_GLOBAL = gitconfig;
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";
for (const v of [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "EMAIL",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
]) {
  delete process.env[v];
}

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
