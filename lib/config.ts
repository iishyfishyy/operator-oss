import path from "node:path";
import os from "node:os";

/**
 * Per-instance configuration, driven entirely by environment variables so an
 * instance can be relocated (fresh container, different user, different ports)
 * with zero code edits. Every value has a documented default — see docs/SELF_HOSTING.md
 * "Configuration" and .env.example.
 *
 * Server-side only. The two plain-Node entrypoints (server.js, pty-server.js)
 * can't import TS, so they read the same env vars directly — keep names in sync.
 */

/** App-data dir for the SQLite database. */
export const DB_DIR = process.env.ORCH_DB_DIR || path.join(os.homedir(), ".zen-orchestrator");

/** Where per-task git worktrees are created (must be outside any project repo). */
export const WORKTREES_DIR =
  process.env.ORCH_WORKTREES_DIR || path.join(os.homedir(), ".agent-orchestrator", "worktrees");

/** Where "Clone a repository" puts cloned repos (the container home's projects/). */
export const PROJECTS_DIR = process.env.ORCH_PROJECTS_DIR || path.join(os.homedir(), "projects");

/**
 * Path to the user's logged-in `claude` binary (Max subscription). The SDK
 * auto-detects it on PATH, but Next's server may run with a trimmed PATH, so
 * we pin it.
 */
export const CLAUDE_CLI_PATH =
  process.env.CLAUDE_CLI_PATH || path.join(os.homedir(), ".local", "bin", "claude");

/**
 * Path to the `codex` binary the Codex driver drives (via @openai/codex-sdk).
 * Empty = let the SDK auto-resolve the binary bundled with its @openai/codex
 * dependency, and let the auth helpers fall back to `codex` on PATH (the Docker
 * image installs it globally next to `claude`). Set this to pin a specific
 * binary when PATH is trimmed or a different install should be used.
 */
export const CODEX_CLI_PATH = process.env.CODEX_CLI_PATH || "";

/**
 * The `approval_policy` the Codex driver passes to the CLI for turns and
 * one-shot helpers. Default "never" is the auto-run analog of Claude's
 * bypassPermissions — turns run unattended in isolated worktrees, with nobody
 * in the loop to answer approval prompts. Enterprise-managed Codex deployments
 * can disallow "never"; the CLI then warns and downgrades, and the driver
 * detects that warning and self-heals to "on-request" from the next turn on
 * (see lib/approvalFailure.ts). Set this to "on-request" or "on-failure" to
 * pick an approval-capable policy up front, or to "inherit" to omit the
 * override entirely so ~/.codex/config.toml and the enterprise requirements
 * decide.
 *
 * "untrusted" (codex's UnlessTrusted) is deliberately NOT accepted: it is the
 * one value that managed requirements allow but that is fatal under the exec
 * transport — non-interactive runs cannot service approvals, so every
 * non-allowlisted command is rejected ("approval request failed") and the task
 * flails. It maps to "on-request", the closest policy that actually works.
 * Unknown values fall back to "never".
 */
export const CODEX_APPROVAL_POLICY = (() => {
  const v = String(process.env.CODEX_APPROVAL_POLICY || "never").toLowerCase();
  if (v === "untrusted") return "on-request";
  return ["never", "on-request", "on-failure", "inherit"].includes(v) ? v : "never";
})();

/**
 * Opt-in to billing an environment-provided agent API key (ANTHROPIC_API_KEY /
 * ANTHROPIC_AUTH_TOKEN / OPENAI_API_KEY). Off by default: both entrypoints
 * strip those vars at boot (lib/env-keys.mjs — server.js and pty-server.js read
 * the env name directly, as does docker/entrypoint.sh) so a key leaked in from
 * a shell profile or unit file can't silently switch turns from the connected
 * subscription login to per-token billing (issue #4). Keys saved through the
 * app's own "I have an API key" path are unaffected — they're re-applied from
 * their 0600 files at db init, after the strip.
 */
export const ALLOW_API_KEY_ENV = ["1", "true", "on"].includes(
  String(process.env.ORCH_ALLOW_API_KEY_ENV || "").toLowerCase(),
);

/**
 * Base TCP port for per-project managed services. Each project is assigned a
 * stable port (base + slot) at creation, stored on its row, injected as PORT
 * into the dev/setup/test service env and the project's PTY shell. Override to
 * relocate the block (e.g. avoid a clash with the app/pty ports). See lib/services.ts.
 */
export const SERVICE_PORT_BASE = process.env.ORCH_SERVICE_PORT_BASE
  ? Number(process.env.ORCH_SERVICE_PORT_BASE)
  : 4300;

/**
 * Per-service log ring-buffer cap (lines). Each managed service keeps at most
 * this many captured stdout/stderr lines in memory — enough to scroll back
 * through startup + recent output without growing unbounded for a dev server
 * that's been up for days.
 */
export const SERVICE_LOG_LINES = process.env.ORCH_SERVICE_LOG_LINES
  ? Number(process.env.ORCH_SERVICE_LOG_LINES)
  : 1500;

/**
 * The origin the app answers on over loopback, for in-container server-to-server
 * calls. The stdio MCP bridge (scripts/orch-mcp.mjs, spawned by the Codex CLI)
 * POSTs the suggest_task / expose_service tool calls back to the app's internal
 * endpoints at this base. Defaults to 127.0.0.1 on the app's own PORT (server.js
 * reads the same PORT). Override only if the app is reached differently from
 * inside the box.
 */
export const INTERNAL_BASE_URL =
  process.env.ORCH_INTERNAL_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;

/** Absolute path to the stdio MCP bridge the non-Claude drivers register per turn. */
export const ORCH_MCP_SCRIPT = path.join(process.cwd(), "scripts", "orch-mcp.mjs");

/**
 * The public origin the app is served from (e.g. https://orch.example.com when
 * behind a tunnel/reverse proxy). Used by the client to build absolute
 * ws(s):// URLs. Empty = same-origin via window.location, which is correct for
 * any single-hostname deployment.
 */
export const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
