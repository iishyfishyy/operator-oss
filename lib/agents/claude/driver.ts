// The Claude Code driver — the Agent SDK behind the AgentDriver seam
// (lib/agents/types.ts). This is the moved lib/claude.ts: runTurn() drives one
// user turn (resume or fresh session; project context appended to the Claude
// Code system prompt), mounts the suggest_task / expose_service MCP tools, and
// normalizes SDK messages into the StreamEvent contract. The one-shot helpers
// (summarize / draft / recap) and the wizard's auth flow (delegating to
// lib/claude-auth.ts) round out the interface.

import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Project, Task, StreamEvent, AskQuestion } from "../../types";
import type { AgentDriver, AgentCapabilities } from "../types";
import { getSetting } from "../../store";
import { createSuggestedTask, registerExposedService, resolveTitleRefs } from "../../agentTools";
import { SUGGEST_TASK, EXPOSE_SERVICE } from "../../agentToolDefs.mjs";
import { waitForAnswer } from "../../asks";
import { CLAUDE_CLI_PATH as CLAUDE_PATH } from "../../config";
import { hasApiKey, looksLikeApiKey, setApiKey, clearApiKey } from "../../anthropic-key";
import {
  buildProjectContext,
  describeToolUse,
  summarizeResult,
  formatAnswers,
  makeQueue,
  resultText,
  clip,
  type ResultKind,
} from "../shared";
import {
  claudeStatus,
  startClaudeLogin,
  getClaudeLogin,
  submitClaudeCode,
  cancelClaudeLogin,
  verifyTurn,
} from "../../claude-auth";

// What Claude Code can do, as data (rendered into the UI's pickers via
// GET /api/agents). Model context windows mirror lib/store.ts
// modelContextWindow; a task row's null model/reasoning/permission means
// "inherit the driver default", so the lists carry only explicit choices.
const CAPABILITIES: AgentCapabilities = {
  models: [
    { value: "fable", label: "Fable", sub: "most powerful", contextWindow: 1_000_000 },
    { value: "opus", label: "Opus", sub: "most capable", contextWindow: 200_000 },
    { value: "sonnet", label: "Sonnet", sub: "balanced", contextWindow: 200_000 },
    { value: "haiku", label: "Haiku", sub: "fastest", contextWindow: 200_000 },
  ],
  reasoningOptions: [
    { value: "off", label: "Off", sub: "no extended thinking" },
    { value: "think", label: "Think", sub: "light reasoning" },
    { value: "think_hard", label: "Think hard", sub: "deeper reasoning" },
    { value: "ultrathink", label: "Ultrathink", sub: "maximum reasoning" },
  ],
  permissionModes: [
    { value: "bypassPermissions", label: "Auto-run", sub: "bypass permissions (default)" },
    { value: "acceptEdits", label: "Accept edits", sub: "auto-accept file edits" },
    { value: "plan", label: "Plan mode", sub: "propose a plan, don't edit" },
  ],
  supportsAsks: true,
  supportsMcpTools: true,
  reportsCostUsd: true,
  supportsResume: true,
  apiKeyHint: "sk-ant-…",
  loginStyle: "paste_code",
};

function orchestratorServer(project: Project, onSuggest: (title: string) => void, onExpose: (info: { name: string; url: string }) => void) {
  // Titles created this session, so `blocked_by` can reference earlier suggestions
  // by title (not just id) — friendlier for the model when planning a roadmap.
  const createdByTitle = new Map<string, string>();
  return createSdkMcpServer({
    name: "orchestrator",
    version: "1.0.0",
    tools: [
      tool(
        EXPOSE_SERVICE.name,
        EXPOSE_SERVICE.description,
        {
          name: z.string().describe(EXPOSE_SERVICE.params.name),
          port: z.number().int().positive().describe(EXPOSE_SERVICE.params.port),
        },
        async (args: { name: string; port: number }) => {
          const { info, url, text } = registerExposedService(project, args.name, args.port);
          onExpose({ name: info.name, url });
          return { content: [{ type: "text", text }] };
        }
      ),
      tool(
        SUGGEST_TASK.name,
        SUGGEST_TASK.description,
        {
          title: z.string().describe(SUGGEST_TASK.params.title),
          description: z.string().describe(SUGGEST_TASK.params.description),
          priority: z.enum(["hi", "med", "lo"]).default("med"),
          blocked_by: z.array(z.string()).optional().describe(SUGGEST_TASK.params.blocked_by),
        },
        async (args: { title: string; description: string; priority: "hi" | "med" | "lo"; blocked_by?: string[] }) => {
          // Resolve refs (id passes through; a title from earlier this session maps
          // to its id) then create + wire deps via the shared logic. Record this
          // task's title→id so later suggestions can reference it by title.
          const { task, text } = createSuggestedTask(project, {
            title: args.title,
            description: args.description,
            priority: args.priority,
            blocked_by: resolveTitleRefs(args.blocked_by, createdByTitle),
          });
          createdByTitle.set(args.title, task.id);
          onSuggest(args.title);
          return { content: [{ type: "text", text }] };
        }
      ),
    ],
  });
}

// Map the UI reasoning preset to the SDK's thinking controls. `maxThinkingTokens`
// is Claude Code's native thinking-budget knob (mirrors the think / think hard /
// ultrathink keywords) and the binary translates it per model — 0 disables, any
// nonzero value enables thinking. On adaptive-only models a budget is treated as
// on/off, so we also scale `effort` to keep higher presets visibly thinking more
// there. null = inherit Claude Code's default (no override).
const REASONING: Record<string, { maxThinkingTokens: number; effort?: "medium" | "high" | "xhigh" }> = {
  off: { maxThinkingTokens: 0 },
  think: { maxThinkingTokens: 4_000, effort: "medium" },
  think_hard: { maxThinkingTokens: 10_000, effort: "high" },
  ultrathink: { maxThinkingTokens: 31_999, effort: "xhigh" },
};

function reasoningOptions(level: string | null): { maxThinkingTokens?: number; effort?: "medium" | "high" | "xhigh" } {
  const r = level ? REASONING[level] : undefined;
  if (!r) return {};
  return r.effort ? { maxThinkingTokens: r.maxThinkingTokens, effort: r.effort } : { maxThinkingTokens: r.maxThinkingTokens };
}

// The task's run permission. null (and any unknown value) keeps the app default of
// bypassPermissions — sessions auto-approve tools and run unattended. "plan" makes
// Claude propose a plan without editing; "acceptEdits" auto-accepts file edits only.
function permissionModeFor(m: string | null): "bypassPermissions" | "acceptEdits" | "plan" {
  return m === "acceptEdits" || m === "plan" ? m : "bypassPermissions";
}

/**
 * Run one user turn against Claude Code and yield stream events.
 * Resumes the task's existing session when present; otherwise starts a fresh
 * session seeded with the project context.
 */
async function* runTurn(
  task: Task,
  project: Project,
  userText: string,
  abortController?: AbortController
): AsyncGenerator<StreamEvent> {
  let sessionId: string | null = task.session_id;
  const suggested: string[] = [];
  // AskUserQuestion tool_use ids — surfaced as interactive "ask" cards by the
  // hook, so their generic tool_use / tool_result blocks are suppressed below.
  const askIds = new Set<string>();
  // Fallback-id uniquifier: one assistant message can carry several asks, and
  // the pending-ask registry keys by id — a shared fallback would collide.
  let askSeq = 0;
  // tool_use id -> how to summarize its eventual result into a peek.
  const resultKinds = new Map<string, ResultKind>();
  const queue = makeQueue<StreamEvent>();

  // Resolve the run controls with a two-level fallback: the task's own choice wins;
  // when it's null ("Default"), inherit the app-level default set in Settings; when
  // that's also unset, fall through to Claude Code's built-in (no thinking override,
  // bypassPermissions).
  // App defaults are agent-scoped ("default_reasoning:<agent>"), falling back to
  // the legacy un-suffixed key so pre-existing settings still apply.
  const reasoning = task.reasoning ?? getSetting(`default_reasoning:${task.agent}`) ?? getSetting("default_reasoning");
  const permission = task.permission_mode ?? getSetting(`default_permission_mode:${task.agent}`) ?? getSetting("default_permission_mode");

  // Chat attachments travel as "[Attached image: /abs/path]" (images) or
  // "[Attached file: /abs/path]" (a large text paste diverted to a file) marker
  // lines in the message text (composed in app/orchestrator/format.ts; files
  // live outside the worktree, see lib/uploads.ts). The Read tool renders images
  // natively and reads text files as text — this nudge makes Claude actually
  // open them. Prompt-only: the persisted transcript keeps the bare markers.
  const prompt = /^\[Attached (image|file): .+\]$/m.test(userText)
    ? `${userText}\n\n(Read each attached image/file with the Read tool before responding.)`
    : userText;

  const response = query({
    prompt,
    options: {
      // Prefer the task's isolated worktree; fall back to the shared repo path
      // (non-git projects, or worktree creation skipped).
      cwd: task.worktree_path || project.repo_path || process.cwd(),
      resume: task.session_id ?? undefined,
      // Per-task model selection ("opus"/"sonnet"/"haiku" alias). Omit to inherit
      // Claude Code's default model.
      ...(task.model ? { model: task.model } : {}),
      // Reasoning preset → thinking budget + effort (Off/Think/Think hard/Ultrathink).
      // Omitted keys leave Claude Code's default thinking.
      ...reasoningOptions(reasoning),
      systemPrompt: { type: "preset", preset: "claude_code", append: buildProjectContext(project, task) },
      // Permission mode (default bypassPermissions; "plan" proposes without editing).
      permissionMode: permissionModeFor(permission),
      pathToClaudeCodeExecutable: CLAUDE_PATH,
      mcpServers: {
        orchestrator: orchestratorServer(
          project,
          (t) => suggested.push(t),
          ({ name, url }) => queue.push({ type: "notice", content: `Service "${name}" is live at ${url}` })
        ),
      },
      // Lets the Stop button interrupt the stream mid-turn (see lib/abort.ts).
      abortController,
      // Newer CLIs (≥2.1.x) only put AskUserQuestion in the model's tool list
      // when the SDK signals it can field interactive prompts by providing
      // canUseTool — without it the tool simply doesn't exist and Claude can
      // never ask (verified against CLI 2.1.198). Under bypassPermissions this
      // callback is otherwise never consulted, and an answered/dismissed ask is
      // resolved by the PreToolUse hook below before permissions are checked,
      // so a blanket allow changes nothing else.
      canUseTool: async (_name: string, input: Record<string, unknown>) => ({ behavior: "allow" as const, updatedInput: input }),
      // bypassPermissions auto-resolves AskUserQuestion with no UI, so the
      // questions never reach the user. This hook intercepts that one tool: it
      // surfaces the questions to the UI (an "ask" event), parks until the user
      // answers, then returns their choices as the tool result so Claude
      // continues in the same session. Everything else stays auto-approved.
      hooks: {
        PreToolUse: [
          {
            matcher: "AskUserQuestion",
            timeout: 86_400, // ~1 day: never time out while the user is deciding
            hooks: [
              async (input, toolUseId) => {
                const ti = (input as { tool_input?: { questions?: AskQuestion[] } }).tool_input;
                const questions = (ti?.questions ?? []) as AskQuestion[];
                const id = toolUseId || (input as { tool_use_id?: string }).tool_use_id || `ask-${sessionId ?? "x"}-${askSeq++}`;
                askIds.add(id);
                queue.push({ type: "ask", id, questions });
                let reason: string;
                try {
                  const answers = await waitForAnswer(task.id, id, questions, abortController?.signal);
                  queue.push({ type: "ask_answered", id, answers });
                  reason = formatAnswers(questions, answers);
                } catch {
                  // Turn torn down (Stop / disconnect) before an answer arrived.
                  reason = "The user dismissed the question without answering.";
                }
                return {
                  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
                };
              },
            ],
          },
        ],
      },
    },
  });

  // Pump SDK messages into the queue. Runs concurrently with the hook (which
  // pushes ask events while this is parked awaiting the tool result).
  const pump = (async () => {
    try {
      for await (const message of response) {
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id;
          queue.push({ type: "session", sessionId });
          // The init message reports the model the SDK actually resolved (e.g. when
          // "default" maps to Opus). Surface it so the UI can badge the live model.
          const resolved = (message as { model?: string }).model;
          if (resolved) queue.push({ type: "model", model: resolved });
        } else if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.trim()) {
              queue.push({ type: "assistant", content: block.text });
            } else if (block.type === "tool_use") {
              // AskUserQuestion is rendered as an interactive card by the hook.
              if (block.name === "AskUserQuestion") continue;
              const { title, detail, peek, diff, resultKind } = describeToolUse(block.name, block.input as Record<string, unknown>);
              if (resultKind) resultKinds.set(block.id, resultKind);
              queue.push({ type: "tool", id: block.id, title, detail, peek, diff });
            }
          }
        } else if (message.type === "user") {
          // Tool results come back as user-role messages with tool_result blocks.
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block && typeof block === "object" && (block as { type?: string }).type === "tool_result") {
                const b = block as { tool_use_id: string; content: unknown; is_error?: boolean };
                // The deny-result of an answered ask is already shown via ask_answered.
                if (askIds.has(b.tool_use_id)) continue;
                const raw = resultText(b.content);
                const kind = resultKinds.get(b.tool_use_id);
                // Summarize from the raw (pre-clip) output so counts are exact.
                const peek = kind && !b.is_error ? summarizeResult(kind, raw) : undefined;
                queue.push({ type: "tool_result", id: b.tool_use_id, content: clip(raw, 6000), isError: !!b.is_error, peek });
              }
            }
          }
        } else if (message.type === "result") {
          // Per-turn spend: the result message carries this turn's dollar cost
          // and token counts. Persisted by the consumer for cumulative totals.
          const u = (message.usage ?? {}) as unknown as Record<string, number>;
          queue.push({
            type: "usage",
            usage: {
              cost_usd: message.total_cost_usd ?? 0,
              input_tokens: u.input_tokens ?? 0,
              output_tokens: u.output_tokens ?? 0,
              cache_read_tokens: u.cache_read_input_tokens ?? 0,
              cache_creation_tokens: u.cache_creation_input_tokens ?? 0,
            },
          });
          if (message.subtype !== "success" && "result" in message === false) {
            queue.push({ type: "error", content: `Run ended: ${message.subtype}` });
          }
        }
      }
    } catch (err) {
      // An abort (Stop button / disconnect) ends the stream deliberately — not an
      // error. The partial transcript is already persisted by the consumer.
      if (!abortController?.signal.aborted) {
        queue.push({ type: "error", content: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      queue.close();
    }
  })();

  for await (const ev of queue.drain()) yield ev;
  await pump;

  for (const t of suggested) yield { type: "suggested", title: t };
  yield { type: "done", sessionId };
}

/**
 * Summarize a transcript into a concise handoff note for the /clear flow.
 * One-shot, no tools — just text in, summary out.
 */
async function summarizeTranscript(transcript: string, project: Project): Promise<string> {
  const response = query({
    prompt:
      `Summarize the following Claude Code session into a concise handoff note for a fresh session ` +
      `continuing the same task. Cover: what was done, the current state of the code, decisions made, ` +
      `and what remains. Be specific about files and follow-ups. Output only the note.\n\n` +
      `=== TRANSCRIPT ===\n${transcript}`,
    options: {
      cwd: project.repo_path || process.cwd(),
      allowedTools: [],
      maxTurns: 1,
      permissionMode: "bypassPermissions",
      pathToClaudeCodeExecutable: CLAUDE_PATH,
    },
  });

  let out = "";
  for await (const message of response) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") out += block.text;
      }
    }
  }
  return out.trim() || "(no summary produced)";
}

// Delimiters Claude wraps the final context document in, so we can extract just
// the document and drop any interim narration ("Let me look at…", "I have enough
// to write the context.") the agent loop emits in the same final message.
const CTX_OPEN = "<<<CONTEXT>>>";
const CTX_CLOSE = "<<<END_CONTEXT>>>";

/**
 * Draft a fresh "what we're building" project-context document by actually
 * reading the codebase. Unlike the one-shot summarizers above, this runs a
 * short read-only agent loop (Read/Grep/Glob/Bash) in the project's repo so
 * Claude can explore the current state of the code and write context that
 * reflects what the project has become. `digest` seeds it with the existing
 * context and recent git activity. Returns markdown the user reviews before
 * saving — we deliberately don't persist here.
 */
async function draftProjectContext(project: Project, digest: string): Promise<string> {
  const response = query({
    prompt:
      `You are refreshing the saved "project context" for the project "${project.name}". ` +
      `This context is prepended to every new Claude Code session in this project, so it must get a ` +
      `fresh session up to speed fast and accurately reflect what the project IS NOW — not what it was ` +
      `when first described.\n\n` +
      `Explore the repository in your working directory using the read-only tools available to you ` +
      `(read key files, list the tree, grep for patterns, check package manifests and configs, skim the ` +
      `README and entry points). Then write the new context.\n\n` +
      `Cover, concisely: what the app does and its purpose; the tech stack and key dependencies; how the ` +
      `code is organized (the directories/modules that matter and what lives where); important conventions, ` +
      `patterns, and constraints; how to run/build/test it; and any other orientation a new contributor needs. ` +
      `Prefer concrete file paths over vague description. Be accurate — only state what you verified in the code. ` +
      `Do not invent features that aren't there.\n\n` +
      `If the project has a dev server, note how it starts and that it must bind the PORT env var the ` +
      `orchestrator injects, and (when the framework enforces host checks) the one-liner that allows the ` +
      `orchestrator's proxied hostname: Vite → server.allowedHosts including process.env.ORCH_PUBLIC_HOST, ` +
      `Next → allowedDevOrigins in next.config; CRA/webpack-dev-server needs nothing (pre-cleared via env).\n\n` +
      `Write the context as plain markdown (no code fences around the whole thing), tight and ` +
      `information-dense, ~200–500 words. Wrap ONLY the final document between a line containing ` +
      `${CTX_OPEN} and a line containing ${CTX_CLOSE}. Put nothing but the document between those ` +
      `markers — any thinking-out-loud goes before the opening marker.\n\n` +
      `=== EXISTING SAVED CONTEXT (may be stale) ===\n${project.context || "(none)"}\n\n` +
      `=== RECENT ACTIVITY ===\n${digest || "(none)"}`,
    options: {
      cwd: project.repo_path || process.cwd(),
      allowedTools: ["Read", "Grep", "Glob", "Bash"],
      maxTurns: 40,
      permissionMode: "bypassPermissions",
      pathToClaudeCodeExecutable: CLAUDE_PATH,
    },
  });

  let out = "";
  for await (const message of response) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") out += block.text;
      }
    }
  }
  // Extract just the wrapped document; fall back to the raw text if the model
  // didn't emit the markers (then strip a stray fence if it wrapped the whole
  // thing in one).
  const open = out.indexOf(CTX_OPEN);
  const close = out.lastIndexOf(CTX_CLOSE);
  let doc = open !== -1 && close > open ? out.slice(open + CTX_OPEN.length, close) : out;
  doc = doc.trim().replace(/^```(?:markdown|md)?\n([\s\S]*)\n```$/, "$1").trim();
  return doc || "(no context produced)";
}

/**
 * Generate a short "where you left off" recap for a project, shown when the
 * user returns after time away. One-shot, no tools. `digest` is the assembled
 * recent activity (task summaries, statuses, recent commits). Describes what
 * happened only — deliberately no next-step suggestions.
 */
async function summarizeProjectRecap(project: Project, digest: string): Promise<string> {
  const response = query({
    prompt:
      `Write a very short "where I left off" recap for the project "${project.name}", shown when the user returns ` +
      `after time away so they can quickly regain context. Output ONLY 2–4 terse markdown bullet points ` +
      `("- " each), one line each, ideally under ~12 words. Be concrete about features, files, and tasks. ` +
      `No headings, no intro/outro sentence, no next steps or TODOs — recap only what has already happened.\n\n` +
      `=== PROJECT CONTEXT ===\n${project.context || "(none)"}\n\n=== RECENT ACTIVITY ===\n${digest}`,
    options: {
      cwd: project.repo_path || process.cwd(),
      allowedTools: [],
      maxTurns: 1,
      permissionMode: "bypassPermissions",
      pathToClaudeCodeExecutable: CLAUDE_PATH,
    },
  });

  let out = "";
  for await (const message of response) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") out += block.text;
      }
    }
  }
  return out.trim() || "(no recap produced)";
}

export const claudeDriver: AgentDriver = {
  id: "claude",
  label: "Claude Code",
  capabilities: CAPABILITIES,
  runTurn,
  summarizeTranscript,
  draftProjectContext,
  summarizeProjectRecap,
  // Auth delegates to lib/claude-auth.ts (the headless `claude auth login`
  // flow); the interface shapes were modeled on it, so this is a direct map.
  authStatus: claudeStatus,
  startLogin: startClaudeLogin,
  getLogin: getClaudeLogin,
  submitLoginCode: submitClaudeCode,
  cancelLogin: cancelClaudeLogin,
  verify: verifyTurn,
  // The "I have an API key instead" path (lib/anthropic-key.ts).
  apiKey: { hint: "sk-ant-…", looksValid: looksLikeApiKey, has: hasApiKey, set: setApiKey, clear: clearApiKey },
};
