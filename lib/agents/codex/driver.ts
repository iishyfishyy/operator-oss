// The OpenAI Codex driver — the `codex` CLI behind the AgentDriver seam
// (lib/agents/types.ts), the counterpart to lib/agents/claude/driver.ts.
//
// @openai/codex-sdk spawns the codex CLI and speaks JSONL over stdio (the same
// architecture as our Claude driver): startThread() for a fresh session,
// resumeThread(id) to continue one. The thread id is emitted as the `session`
// StreamEvent, so the existing lineage/resume machinery (sessions table,
// /clear generations) works unchanged — a codex thread id is just another
// opaque id in tasks.session_id. runTurn() normalizes codex's ThreadEvent
// stream into the StreamEvent contract via lib/agents/codex/events.ts.
//
// Codex non-interactive mode can't ask the user natively, but the stdio MCP
// bridge (scripts/orch-mcp.mjs) mounts the orchestrator tools — so
// supportsMcpTools=true, and its ask_user tool restores interactive asks: the
// tool call parks server-side until the user answers the card (see
// lib/agentTools.startAskUser), so supportsAsks=true. ChatGPT-plan auth
// reports token counts only (no dollar figure), so reportsCostUsd=false —
// instead usage carries an ESTIMATED cost (tokens × published API prices,
// see ./pricing.ts) and costIsEstimated=true tells the UI to label it ~.

import { Codex } from "@openai/codex-sdk";
import type { SandboxMode, ApprovalMode, ModelReasoningEffort, ThreadOptions, CodexOptions } from "@openai/codex-sdk";
import type { Project, Task, StreamEvent } from "../../types";
import type { AgentDriver } from "../types";
import { CODEX_CAPABILITIES } from "./capabilities";
import { getSetting } from "../../store";
import { CODEX_CLI_PATH, INTERNAL_BASE_URL, ORCH_MCP_SCRIPT } from "../../config";
import { buildProjectContext } from "../shared";
import { mapThreadEvent, newState } from "./events";
import { resolveCodexModel } from "./pricing";
import { codexStatus, verifyCodexTurn, startCodexLogin, getCodexLogin, submitCodexCode, cancelCodexLogin, codexApiKey } from "./auth";

// Register the orchestrator's stdio MCP bridge as a Codex mcp_server for this
// turn. The bridge is a thin proxy: the CLI spawns `node scripts/orch-mcp.mjs`
// and the tool calls POST back to the app's internal endpoints, authenticated
// with the per-instance SERVICE_TOKEN and scoped to this task/project via env.
// `command` is the absolute node binary (process.execPath) so the spawn doesn't
// depend on PATH being present in the MCP subprocess env. The Codex SDK flattens
// this `config` object into `--config mcp_servers.…` overrides (TOML) for the CLI.
function orchestratorMcpConfig(project: Project, task: Task): CodexOptions["config"] {
  return {
    mcp_servers: {
      orchestrator: {
        command: process.execPath,
        args: [ORCH_MCP_SCRIPT],
        // ask_user blocks until the user answers — hours, potentially. Codex's
        // default per-tool-call timeout (60s) would kill the parked call, so
        // raise it to ~1 day (mirrors the Claude driver's PreToolUse hook cap).
        tool_timeout_sec: 86_400,
        env: {
          ORCH_TASK_ID: task.id,
          ORCH_PROJECT_ID: project.id,
          ORCH_BASE_URL: INTERNAL_BASE_URL,
          SERVICE_TOKEN: process.env.SERVICE_TOKEN || "",
        },
      },
    },
  };
}

// Reasoning preset → codex model_reasoning_effort. null / unknown = inherit
// codex's default (no override).
const EFFORT: Record<string, ModelReasoningEffort> = {
  off: "minimal",
  think: "low",
  think_hard: "high",
  ultrathink: "xhigh",
};

function reasoningEffort(level: string | null): { modelReasoningEffort?: ModelReasoningEffort } {
  const e = level ? EFFORT[level] : undefined;
  return e ? { modelReasoningEffort: e } : {};
}

type RunControls = { sandboxMode: SandboxMode; approvalPolicy: ApprovalMode; networkAccessEnabled: boolean };

// The task's run permission → codex sandbox + approval policy. Default (null /
// unknown / "bypassPermissions") is the auto-run analog of Claude's
// bypassPermissions: write within the workspace, run commands and reach the
// network without approvals — safe because tasks run in isolated worktrees /
// a hardened container. "plan" runs read-only so codex proposes without editing.
function runControls(mode: string | null): RunControls {
  if (mode === "plan") return { sandboxMode: "read-only", approvalPolicy: "never", networkAccessEnabled: false };
  return { sandboxMode: "workspace-write", approvalPolicy: "never", networkAccessEnabled: true };
}

/**
 * Run one user turn against Codex and yield stream events. Resumes the task's
 * existing thread when present; otherwise starts a fresh thread with the
 * project context prepended to the first prompt (codex has no system-prompt
 * append, so context seeds the opening message; resume turns rely on codex's
 * own thread persistence in ~/.codex/sessions).
 */
async function* runTurn(
  task: Task,
  project: Project,
  userText: string,
  abortController?: AbortController
): AsyncGenerator<StreamEvent> {
  let sessionId: string | null = task.session_id;
  // The model the turn effectively runs: the task's choice, else the CLI's
  // default (codex emits no model event of its own, so this resolved value is
  // the best truth available). It prices the cost estimate and is reported as
  // a `model` event so the badge + Insights provider panel populate. When the
  // task didn't choose, we still OMIT the model override below — a user's
  // ~/.codex/config.toml default keeps winning — so the resolved value is an
  // assumption in that edge case, consistent with the estimated-cost framing.
  const model = resolveCodexModel(task.model);
  const state = newState(model);

  // Fallback (task choice → agent-scoped app default → legacy default → codex
  // built-in), matching the Claude driver.
  const reasoning = task.reasoning ?? getSetting(`default_reasoning:${task.agent}`) ?? getSetting("default_reasoning");
  const permission = task.permission_mode ?? getSetting(`default_permission_mode:${task.agent}`) ?? getSetting("default_permission_mode");
  const controls = runControls(permission);

  const threadOptions: ThreadOptions = {
    // Prefer the task's isolated worktree; fall back to the shared repo path.
    workingDirectory: task.worktree_path || project.repo_path || process.cwd(),
    // Worktrees are git repos, but non-git projects and the cwd fallback may not
    // be — skip the check so codex never hard-errors on a missing repo.
    skipGitRepoCheck: true,
    sandboxMode: controls.sandboxMode,
    approvalPolicy: controls.approvalPolicy,
    networkAccessEnabled: controls.networkAccessEnabled,
    ...(task.model ? { model: task.model } : {}),
    ...reasoningEffort(reasoning),
  };

  const codex = new Codex({
    codexPathOverride: CODEX_CLI_PATH || undefined,
    config: orchestratorMcpConfig(project, task),
  });
  const thread = task.session_id ? codex.resumeThread(task.session_id, threadOptions) : codex.startThread(threadOptions);

  // Fresh session: seed the opening prompt with the project context (project
  // description, task framing, and carried summaries from prior generations).
  const prompt = task.session_id ? userText : `${buildProjectContext(project, task)}\n\n---\n\n${userText}`;

  yield { type: "model", model };

  try {
    const { events } = await thread.runStreamed(prompt, { signal: abortController?.signal });
    for await (const ev of events) {
      for (const out of mapThreadEvent(ev, state)) yield out;
    }
  } catch (err) {
    // A Stop (abort) kills the codex process, which surfaces here as a throw —
    // deliberate teardown, not an error. The partial transcript is already
    // persisted by the runner. Any other throw is a real failure.
    if (!abortController?.signal.aborted) {
      yield { type: "error", content: err instanceof Error ? err.message : String(err) };
    }
  }

  // thread.id is populated from the thread.started event (or was set verbatim on
  // resume); fall back to whatever we already had.
  sessionId = thread.id ?? sessionId;
  yield { type: "done", sessionId };
}

// ---------- one-shot helpers (no session, text in → text out) ----------

// Runaway bounds for the one-shot helpers, the codex analog of the Claude
// driver's maxTurns (1 for the text-only summarize/recap, 40 for the
// repo-exploring draft). Codex has no turn/iteration knob, so we bound the
// number of thread ITEMS (commands, file reads, reasoning blocks, …) the
// streamed run may start before we abort it. Text-only prompts need ~2 items
// (reasoning + the reply); the explore bound is roomy because a draft run
// legitimately reads dozens of files.
const ONESHOT_MAX_ITEMS_TEXT = 20;
const ONESHOT_MAX_ITEMS_EXPLORE = 120;

// A minimal read-only agent loop, shared by the summarize/draft/recap helpers:
// no writes, no approvals, no network, and at most `maxItems` items before the
// run is cut off (returning whatever the agent had said by then). Any failure
// degrades to empty text (callers add their own "(no … produced)" fallback) so
// a failed helper turn never rejects into the recap/refresh jobs — mirrors the
// Claude driver, whose collectors always return a string.
async function oneShot(project: Project, prompt: string, maxItems: number, mode: SandboxMode = "read-only"): Promise<string> {
  const codex = new Codex({ codexPathOverride: CODEX_CLI_PATH || undefined });
  const thread = codex.startThread({
    workingDirectory: project.repo_path || process.cwd(),
    skipGitRepoCheck: true,
    sandboxMode: mode,
    approvalPolicy: "never",
    networkAccessEnabled: false,
  });
  const abort = new AbortController();
  let items = 0;
  // The last agent_message wins — the same semantics as the SDK's finalResponse.
  let finalResponse = "";
  try {
    const { events } = await thread.runStreamed(prompt, { signal: abort.signal });
    for await (const ev of events) {
      if (ev.type === "turn.failed" || ev.type === "error") return "";
      if (ev.type === "item.started" && ++items > maxItems) {
        abort.abort(); // kills the codex process; keep what we have
        break;
      }
      if (ev.type === "item.completed" && ev.item.type === "agent_message") finalResponse = ev.item.text;
    }
  } catch {
    // Aborting above surfaces as a throw from the stream — that's the guard
    // firing, not a failure. A throw without our abort is a real error: degrade.
    if (!abort.signal.aborted) return "";
  }
  return finalResponse.trim();
}

async function summarizeTranscript(transcript: string, project: Project): Promise<string> {
  const out = await oneShot(
    project,
    `Summarize the following Codex session into a concise handoff note for a fresh session continuing the ` +
      `same task. Cover: what was done, the current state of the code, decisions made, and what remains. Be ` +
      `specific about files and follow-ups. Output only the note.\n\n=== TRANSCRIPT ===\n${transcript}`,
    ONESHOT_MAX_ITEMS_TEXT
  );
  return out || "(no summary produced)";
}

const CTX_OPEN = "<<<CONTEXT>>>";
const CTX_CLOSE = "<<<END_CONTEXT>>>";

async function draftProjectContext(project: Project, digest: string): Promise<string> {
  const out = await oneShot(
    project,
    `You are refreshing the saved "project context" for the project "${project.name}". This context is prepended ` +
      `to every new session in this project, so it must get a fresh session up to speed fast and accurately reflect ` +
      `what the project IS NOW.\n\n` +
      `Explore the repository in your working directory (read key files, list the tree, grep for patterns, check ` +
      `package manifests and configs, skim the README and entry points). Then write the new context.\n\n` +
      `Cover, concisely: what the app does and its purpose; the tech stack and key dependencies; how the code is ` +
      `organized (the directories/modules that matter and what lives where); important conventions, patterns, and ` +
      `constraints; how to run/build/test it; and any other orientation a new contributor needs. Prefer concrete ` +
      `file paths over vague description. Be accurate — only state what you verified in the code.\n\n` +
      `Write the context as plain markdown (no code fences around the whole thing), tight and information-dense, ` +
      `~200–500 words. Wrap ONLY the final document between a line containing ${CTX_OPEN} and a line containing ` +
      `${CTX_CLOSE}.\n\n=== EXISTING SAVED CONTEXT (may be stale) ===\n${project.context || "(none)"}\n\n` +
      `=== RECENT ACTIVITY ===\n${digest || "(none)"}`,
    ONESHOT_MAX_ITEMS_EXPLORE
  );
  const open = out.indexOf(CTX_OPEN);
  const close = out.lastIndexOf(CTX_CLOSE);
  let doc = open !== -1 && close > open ? out.slice(open + CTX_OPEN.length, close) : out;
  doc = doc.trim().replace(/^```(?:markdown|md)?\n([\s\S]*)\n```$/, "$1").trim();
  return doc || "(no context produced)";
}

async function summarizeProjectRecap(project: Project, digest: string): Promise<string> {
  const out = await oneShot(
    project,
    `Write a very short "where I left off" recap for the project "${project.name}", shown when the user returns after ` +
      `time away. Output ONLY 2–4 terse markdown bullet points ("- " each), one line each, ideally under ~12 words. ` +
      `Be concrete about features, files, and tasks. No headings, no intro/outro, no next steps — recap only what has ` +
      `already happened.\n\n=== PROJECT CONTEXT ===\n${project.context || "(none)"}\n\n=== RECENT ACTIVITY ===\n${digest}`,
    ONESHOT_MAX_ITEMS_TEXT
  );
  return out || "(no recap produced)";
}

export const codexDriver: AgentDriver = {
  id: "codex",
  label: "Codex",
  capabilities: CODEX_CAPABILITIES,
  runTurn,
  summarizeTranscript,
  draftProjectContext,
  summarizeProjectRecap,
  // Auth delegates to lib/agents/codex/auth.ts (the headless `codex login
  // --device-auth` flow + `codex login status` / a one-shot verify turn).
  authStatus: codexStatus,
  startLogin: startCodexLogin,
  getLogin: getCodexLogin,
  submitLoginCode: submitCodexCode,
  cancelLogin: cancelCodexLogin,
  verify: verifyCodexTurn,
  apiKey: codexApiKey,
};
