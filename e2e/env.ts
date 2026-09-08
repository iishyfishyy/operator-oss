// Hermetic run environment for the Playwright suite. One temp root per run —
// created by the first process that loads this module (Playwright's main
// process) and shared with worker processes via ORCH_E2E_ROOT, which children
// inherit. Everything the app persists (SQLite, worktrees, cloned/seeded repos)
// lands under this root, so an e2e run never touches ~/.zen-orchestrator or the
// developer's real projects, and every run starts from a truly fresh instance
// (which is what makes the onboarding spec deterministic).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function ensureRoot(): string {
  let root = process.env.ORCH_E2E_ROOT;
  if (!root) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "orch-e2e-"));
    process.env.ORCH_E2E_ROOT = root;
  }
  for (const d of ["db", "worktrees", "projects", "fixtures"]) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  // Pinned git identity/config for BOTH the server (worktree + merge commits)
  // and the test helpers (fixture repos) — hermetic like tests/setup.ts, so the
  // suite passes on a machine with no global git config, and no user hooks or
  // signing setup can interfere.
  const gitconfig = path.join(root, "gitconfig");
  if (!fs.existsSync(gitconfig)) {
    fs.writeFileSync(
      gitconfig,
      [
        "[user]",
        "\tname = Orchestrator E2E",
        "\temail = e2e@example.com",
        "[init]",
        "\tdefaultBranch = main",
        "[commit]",
        "\tgpgsign = false",
        "[core]",
        `\thooksPath = ${os.platform() === "win32" ? "NUL" : "/dev/null"}`,
        "",
      ].join("\n")
    );
  }
  return root;
}

export const E2E_ROOT = ensureRoot();
export const E2E_PORT = Number(process.env.ORCH_E2E_PORT || 4711);
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
export const FIXTURES_DIR = path.join(E2E_ROOT, "fixtures");

export const GIT_ENV = {
  GIT_CONFIG_GLOBAL: path.join(E2E_ROOT, "gitconfig"),
  GIT_CONFIG_SYSTEM: os.platform() === "win32" ? "NUL" : "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

/** Env for the app under test (server.js + pty-server.js via `npm start`). */
export const SERVER_ENV: Record<string, string> = {
  PORT: String(E2E_PORT),
  HOSTNAME: "127.0.0.1",
  PTY_PORT: String(E2E_PORT + 1),
  PTY_HOST: "127.0.0.1",
  ORCH_DB_DIR: path.join(E2E_ROOT, "db"),
  ORCH_WORKTREES_DIR: path.join(E2E_ROOT, "worktrees"),
  ORCH_PROJECTS_DIR: path.join(E2E_ROOT, "projects"),
  // Keep the managed-services port block clear of the app/pty ports.
  ORCH_SERVICE_PORT_BASE: String(E2E_PORT + 100),
  // Registers the deterministic mock agent (lib/agents/mock/driver.ts) so
  // onboarding and turns run without any real agent CLI or login.
  ORCH_E2E_MOCK_AGENT: "1",
  ORCH_FEATURE_OMNI_SEARCH: "1",
  // Never phone analytics home from a test run.
  POSTHOG_KEY: "",
  ...GIT_ENV,
};
