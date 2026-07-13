export type Priority = "hi" | "med" | "lo";
export type Status = "not_started" | "in_progress" | "on_hold" | "done" | "cancelled";
export type MsgRole = "user" | "assistant" | "tool" | "system" | "session_break";

export interface Project {
  id: string;
  name: string;
  icon: string;
  sub: string; // short tagline, e.g. "notes app"
  color: string; // accent color for the project glyph
  context: string; // "what we're building" — description, stack & conventions (single field)
  building: string; // legacy — kept for back-compat, folded into context
  conventions: string; // legacy — kept for back-compat, folded into context
  repo_path: string; // working dir for Claude Code
  branch: string; // git branch (context only)
  dev_command: string; // long-running dev server command supervised by lib/services.ts ("" = none)
  setup_command: string; // optional one-shot setup command (install/migrate/etc.)
  test_command: string; // optional one-shot test command
  port: number; // deterministic per-project port, injected as PORT into services + the PTY
  default_agent: string; // agent driver new tasks in this project run under (lib/agents/registry.ts)
  recap: string; // last LLM "where you left off" recap (auto-generated when idle)
  recap_at: number; // when the recap was generated (0 = none)
  recap_covers_at: number; // the project's last-activity ts the recap was based on
  // Detached "Refresh with AI" job (drafts run in the background; see lib/contextRefresh.ts).
  refresh_status: "idle" | "running" | "done" | "error";
  refresh_draft: string; // drafted context awaiting the user's review (when status="done")
  refresh_error: string; // failure message (when status="error")
  refresh_started_at: number; // when the current/last job started (ms epoch, 0 = never)
  position: number; // manual sidebar order (ascending)
  deprecated: number; // 1 = hidden in the sidebar's "deprecated" area, not built on
  seeded: number; // 1 = the built-in "Welcome" tutorial project (see lib/db.ts seedIfEmpty)
  created_at: number;
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string;
  priority: Priority;
  status: Status;
  suggested: number; // 1 = Claude-proposed, idle in the suggested tray
  agent: string; // agent driver this task's sessions run under (default "claude"; see lib/agents/)
  model: string | null; // chosen model alias ("fable"|"opus"|"sonnet"|"haiku"); null = inherit default
  resolved_model: string | null; // model the SDK actually ran last turn (for the badge)
  reasoning: string | null; // thinking preset ("off"|"think"|"think_hard"|"ultrathink"); null = inherit default
  permission_mode: string | null; // run permission ("acceptEdits"|"plan"); null = bypassPermissions (default)
  session_id: string | null; // the agent's opaque session/thread id for the current generation
  worktree_path: string; // isolated git worktree this task runs in ("" = runs in repo_path)
  work_branch: string; // the worktree's branch (e.g. "orch/<id>")
  base_sha: string; // commit the worktree branched from — the stable diff/merge base
  merged_at: number; // when this task's branch was merged back (0 = not merged)
  generation: number; // increments on each /clear
  started: number; // 1 once the initial prompt has been sent
  running: number; // 1 while a Claude turn is actively streaming
  awaiting_input: number; // 1 when it's your turn: Claude's turn ended mid-task, or it's parked on an AskUserQuestion
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: string;
  task_id: string;
  generation: number;
  role: MsgRole;
  content: string;
  created_at: number;
}

export interface Summary {
  id: string;
  task_id: string;
  generation: number;
  summary: string;
  created_at: number;
}

// A follow-up the user typed while a turn was still running. Parked in the
// pending_messages table (FIFO per task) and shown as "queued" in the
// transcript; the runner dequeues the oldest one as the next turn when the
// current turn ends. Distinct from `messages` (the committed transcript).
export interface PendingMessage {
  id: string;
  task_id: string;
  generation: number;
  content: string;
  created_at: number;
}

export interface Session {
  id: string;
  project_id: string;
  task_id: string;
  generation: number;
  // The agent's own opaque session/thread id (named for the first driver; any
  // driver's id — e.g. a Codex thread id — lands in this same column).
  claude_session_id: string | null;
  started_at: number;
  ended_at: number | null;
}

// ---------- managed services (lib/services.ts) ----------

// A supervised process belonging to a project. `kind` is the configured slot the
// service maps to ("dev"/"setup"/"test"), or "exposed" for a server Claude
// registered at runtime via the expose_service MCP tool (we don't own that
// process, we only track its url). The orchestrator can start/stop/restart the
// configured kinds; an exposed entry is informational (its url is reportable).
export type ServiceStatus = "stopped" | "starting" | "running" | "exited" | "errored";
export type ServiceKind = "dev" | "setup" | "test" | "exposed";
// Who can open a service's public URL: private = the instance's own session
// auth, shared = anyone holding the tokened link (?t=…), public = anyone.
export type ServiceVisibility = "private" | "shared" | "public";

export interface ServiceInfo {
  projectId: string;
  name: string; // unique per project — the kind for configured services, or Claude's chosen name
  kind: ServiceKind;
  command: string; // the shell command (empty for an exposed, externally-started service)
  status: ServiceStatus;
  pid: number | null;
  exitCode: number | null;
  port: number; // the port injected as PORT (configured) or reported by expose_service
  url: string | null; // browseable URL once running/exposed
  startedAt: number | null;
  managed: boolean; // true if the orchestrator owns the process (can stop/restart)
  slug: string | null; // public hostname label (<slug>--<host>); null until first persisted
  visibility: ServiceVisibility;
  shareUrl: string | null; // tokened link (url?t=…) when visibility is "shared"
}

// One captured line of a service's combined stdout/stderr.
export interface ServiceLogLine {
  ts: number;
  stream: "stdout" | "stderr" | "system"; // "system" = supervisor notice (started/exited)
  text: string;
}

// Live events on a project's services SSE stream (GET .../services/stream).
export type ServiceEvent =
  | { type: "snapshot"; services: ServiceInfo[]; logs: Record<string, ServiceLogLine[]> }
  | { type: "status"; service: ServiceInfo }
  | { type: "log"; name: string; line: ServiceLogLine }
  | { type: "removed"; name: string };

// A multiple-choice question Claude raised via the AskUserQuestion tool.
export interface AskOption {
  label: string;
  description?: string;
}
export interface AskQuestion {
  question: string;
  header: string; // short chip label (≤12 chars)
  multiSelect?: boolean;
  options: AskOption[];
}
// answers[i] = the chosen value(s) for question i — option labels and/or the
// free-text typed into "Other". One entry per question, in question order.
export type AskAnswers = string[][];

// Token usage + dollar cost for one Claude turn, parsed from the SDK result
// message. Persisted per turn (task_usage table) and summed for cumulative spend.
export interface TurnUsage {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

// Cumulative usage totals across one task (or project): summed turn usage plus
// `total_tokens` (the four token counts combined) and the turn count.
export interface UsageTotals extends TurnUsage {
  total_tokens: number;
  turns: number;
}

// One rendered diff line: added (+, green), removed (-, red), or unchanged
// context (" ", dim). Used by both the capped peek and the full expanded diff.
export type DiffLine = { sign: "+" | "-" | " "; text: string };

// An always-visible "peek" at a tool's effect — mimics Claude Code's `⎿` line.
// `count`: a one-liner (Read N lines / Found N matches) with no content shown.
// `diff`: a -/+ hunk for Edits/Writes.  `lines`: a short snippet (Bash output)
// with a +N-more affordance.  `todos`: a rendered checklist.
export type ToolPeek =
  | { kind: "count"; text: string }
  | { kind: "diff"; added: number; removed: number; label?: string; lines: DiffLine[]; truncated?: number }
  | { kind: "lines"; label?: string; lines: string[]; truncated?: number }
  | { kind: "todos"; items: { text: string; status: string }[] };

// Server-sent stream events from a Claude turn.
export type StreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "model"; model: string }
  | { type: "assistant"; content: string }
  | { type: "tool"; id: string; title: string; detail: string; peek?: ToolPeek; diff?: DiffLine[] }
  | { type: "tool_result"; id: string; content: string; isError: boolean; peek?: ToolPeek }
  | { type: "ask"; id: string; questions: AskQuestion[] }
  | { type: "ask_answered"; id: string; answers: AskAnswers }
  | { type: "suggested"; title: string }
  | { type: "usage"; usage: TurnUsage }
  | { type: "notice"; content: string } // a quiet, non-error system note (e.g. "caught up to main")
  | { type: "error"; content: string }
  | { type: "done"; sessionId: string | null };

// Events as delivered over the task event bus and the GET /messages SSE tail.
// Turn events are enriched with the persisted DB message id (+ generation) so
// reconnecting clients can upsert idempotently instead of blindly appending:
// `msgId` is the row the event created (assistant/tool/ask/notice/error/user)
// or updated in place (tool_result/ask_answered). `snapshot` opens every
// stream — the full persisted transcript plus whether a turn is live — and
// `turn_end` marks the runner's finally block (running flag is off, task row
// settled), letting clients refresh without owning the turn's lifetime.
// `queued` is a follow-up parked while a turn runs; `dequeued` removes a parked
// follow-up from the transcript — either because the runner is now running it
// as the next turn, or because it was cancelled. `snapshot` carries the parked
// queue too, so a reload mid-run re-renders the queued bubbles.
export type TaskStreamEvent =
  | (StreamEvent & { msgId?: string; generation?: number })
  | { type: "user"; content: string; msgId: string; generation: number }
  | { type: "queued"; msgId: string; content: string; generation: number }
  | { type: "dequeued"; msgId: string }
  | { type: "snapshot"; messages: Message[]; pending: PendingMessage[]; running: boolean }
  | { type: "turn_end" };

// Coarse cross-task lifecycle events on the always-open GET /api/events stream
// (the wildcard channel of lib/events.ts). One event per turn boundary — turn
// launched, parked on a question, question answered, suggestion created, turn
// ended — carrying the task row's settled running/awaiting_input/status (the
// runner persists before it publishes, so these are authoritative) plus the
// project's fresh awaiting count. This is what keeps spinners, project badges,
// and the "N need you" pill live for tasks whose transcript stream isn't open.
export type GlobalTaskEvent = {
  type: "task";
  event: "turn_started" | "awaiting_input" | "ask_answered" | "suggested" | "turn_end";
  taskId: string;
  projectId: string;
  running: boolean;
  awaiting_input: boolean;
  status: Status;
  /** In-progress tasks awaiting the user across this task's project. */
  awaiting_count: number;
};

// How a tool call is stored (JSON) in a "tool" message's content.
export interface ToolData {
  title: string;
  detail?: string;
  result?: string;
  isError?: boolean;
  // Always-visible summary/snippet of the call's effect (see ToolPeek). Input-
  // derived peeks (diff/todos/write) are set with the tool event; result-derived
  // peeks (read count, bash output) are filled in when the tool_result arrives.
  peek?: ToolPeek;
  // Full colored diff for Edit/Write, rendered in the expanded body (the peek
  // shows a capped slice of the same lines). Absent on older persisted messages,
  // which fall back to the plaintext `detail`.
  diff?: DiffLine[];
  // Present when this "tool" message is an AskUserQuestion prompt. `id` is the
  // tool_use id (stored here so it survives a reload — there's no DB column for
  // it). `answers` is absent while awaiting the user, set once answered.
  ask?: { id: string; questions: AskQuestion[]; answers?: AskAnswers };
}
