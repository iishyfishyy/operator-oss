// Client-side shapes + UI constants shared across the orchestrator modules.
// Pure data only (no React / no Icon) so any module can import freely.
import type { Priority, Status } from "@/lib/types";

// ---------- client shapes ----------
export interface ProjectRow {
  id: string;
  name: string;
  icon: string;
  sub: string;
  color: string;
  context: string;
  repo_path: string;
  branch: string;
  dev_command: string;
  setup_command: string;
  test_command: string;
  default_agent: string; // agent driver new tasks in this project default to (lib/agents/registry.ts)
  port: number;
  deprecated: number;
  seeded: number; // 1 = built-in "Welcome" tutorial project (coach marks + post-merge nudge)
  task_count: number;
  last_activity: number;
  awaiting_count: number; // in-progress tasks waiting on the user (across this project)
  cost_usd: number; // cumulative dollar spend across all this project's tasks
}
export interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  priority: Priority;
  status: Status;
  suggested: number;
  agent: string; // agent driver this task's sessions run under (lib/agents/); fixed for the task's life
  model: string | null;
  resolved_model: string | null;
  reasoning: string | null; // thinking preset; null = inherit default
  permission_mode: string | null; // run permission; null = bypassPermissions (default)
  session_id: string | null;
  pr_url: string; // GitHub PR opened from this task's branch ("" = none yet)
  generation: number;
  started: number;
  running: number;
  awaiting_input: number;
  updated_at: number;
  cost_usd: number; // cumulative dollar spend across all turns of this task
  total_tokens: number; // cumulative tokens (input+output+cache) across all turns
  depends_on: string[]; // task ids this task is blocked by until they're done
  context_tokens: number; // latest turn's input-side tokens ≈ current context-window occupancy
  context_pct: number; // context_tokens as a percent (0–100) of the model's window
}
// A single row in the titlebar "need you" dropdown: an awaiting task plus enough
// of its project to label and color it. Mirrors lib/store.ts listNeedsYou().
export interface NeedsYouRow {
  id: string;
  project_id: string;
  title: string;
  project_name: string;
  project_color: string;
  project_icon: string;
  waiting_since: number;
}
// A row in the ⌘K palette's session search: any real task across the active
// projects plus enough of its project to label it. Mirrors lib/store.ts
// listAllTasksLite().
export interface PaletteTaskRow {
  id: string;
  project_id: string;
  title: string;
  status: Status;
  running: number;
  awaiting_input: number;
  updated_at: number;
  project_name: string;
  project_color: string;
  project_icon: string;
}
export interface Msg {
  id: string;
  // "queued" is a client-only role: a follow-up the user typed mid-turn that's
  // parked (in pending_messages) until the current turn ends. Not a persisted
  // message role — it never lands in the `messages` table.
  role: "user" | "assistant" | "tool" | "system" | "session_break" | "queued";
  content: string;
  generation: number;
  toolId?: string; // tool_use id, for merging the tool_result that arrives later
}
export interface ProjectSession {
  id: string;
  task_id: string;
  task_title: string;
  task_status: Status;
  generation: number;
  claude_session_id: string | null;
  started_at: number;
  ended_at: number | null;
  message_count: number;
}
export interface RecapInfo {
  recap: string | null;
  recap_at: number;
  hasHistory: boolean;
  stale: boolean;
  needsRecap: boolean;
  generating: boolean;
  lastActivity: number;
  // Client-side only: set when the fetch/generate failed, so the landing pane
  // can offer a retry instead of silently showing nothing.
  error?: string;
}

// Divergence status for the reopened-task sync banner (GET /api/tasks/:id/sync).
export interface SyncStatusResp {
  isolated: boolean;
  baseBranch?: string;
  behind?: number;
  ahead?: number;
  isDirty?: boolean;
  canFastForward?: boolean;
  clean?: boolean;
  conflicts?: string[];
}

export type FsListing = { path: string; parent: string | null; home: string; entries: { name: string; path: string }[] };

// ---------- GitHub onboarding shapes ----------
export type GhStatusT = { installed: boolean; authenticated: boolean; login: string | null };
export type GhLoginT = { status: "idle" | "starting" | "awaiting" | "success" | "error"; code: string | null; url: string | null; user: string | null; error: string | null };
export type GhRepoT = { nameWithOwner: string; description: string; isPrivate: boolean; updatedAt: string };

// ---------- first-run onboarding wizard shapes ----------
export type OnbStep = "connect" | "verify";
export type OnboardingT = {
  complete: boolean;
  step: OnbStep;
  method: "subscription" | "api_key" | null;
  account: { email: string | null; plan: string | null } | null;
};
export type ClaudeLoginT = {
  status: "idle" | "starting" | "awaiting" | "submitting" | "success" | "error";
  url: string | null;
  email: string | null;
  plan: string | null;
  error: string | null;
  log: string;
};
export type ClaudeVerifyT = {
  connected: boolean;
  email: string | null;
  plan: string | null;
  method: string | null;
  error: string | null;
};

// ---------- multi-agent connect (GET /api/agents + /api/agents/[id]/*) ----------
// Mirrors the server's AgentCapabilities + per-agent connection state. Used by
// the Settings "Agents" surface to render connect cards and gray out agents that
// aren't wired up. Only the fields the client reads are typed here.
export type AgentCapabilitiesT = {
  apiKeyHint: string | null;
  loginStyle: "paste_code" | "device_code";
};
export type AgentInfoT = {
  id: string;
  label: string;
  capabilities: AgentCapabilitiesT;
  connected: boolean;
  account: { email: string | null; plan: string | null; method: "subscription" | "api_key" } | null;
};
export type AgentsResponseT = { default: string; agents: AgentInfoT[] };
export type AgentLoginT = ClaudeLoginT & { code?: string | null };

// ---------- status maps (DB status -> design's r/a/g classes + labels) ----------
export const SCLS: Record<Status, "r" | "a" | "g" | "h" | "x"> = { not_started: "r", in_progress: "a", on_hold: "h", done: "g", cancelled: "x" };
export const SLABEL: Record<Status, string> = { not_started: "Not started", in_progress: "In progress", on_hold: "On hold", done: "Done", cancelled: "Cancelled" };
export const AWAIT_LABEL = "Needs your input";
export const SSUB: Record<Status, string> = { not_started: "no session yet", in_progress: "session active or paused", on_hold: "paused — pick up later", done: "work complete / merged", cancelled: "abandoned — won't be finished" };
export const STATUSES: Status[] = ["not_started", "in_progress", "on_hold", "done", "cancelled"];
export const PLABEL: Record<Priority, string> = { hi: "High", med: "Medium", lo: "Low" };
export const PRIORITIES: Priority[] = ["hi", "med", "lo"];

// ---------- agent capability descriptors (mirrors lib/agents/types.ts) ----------
// The run controls are no longer hardcoded per agent: each driver ships a
// capability descriptor (models / reasoning / permission modes it supports, plus
// feature flags) served by GET /api/agents. The client renders every picker from
// this data, so a task's controls always match the agent it runs under.
export interface AgentModelOption { value: string; label: string; sub: string; contextWindow: number }
export interface AgentPickerOption { value: string; label: string; sub: string }
export interface AgentCapabilities {
  models: AgentModelOption[];
  reasoningOptions: AgentPickerOption[];
  permissionModes: AgentPickerOption[];
  supportsAsks: boolean;      // can surface interactive ask cards mid-turn
  supportsMcpTools: boolean;  // can mount the orchestrator MCP tools
  reportsCostUsd: boolean;    // usage carries a real dollar cost (not just tokens)
  supportsResume: boolean;    // turns can resume a prior session/thread id
}
export interface AgentInfo { id: string; label: string; capabilities: AgentCapabilities; authenticated: boolean }
export interface AgentsBundle { default: string; agents: AgentInfo[] }
export const EMPTY_AGENTS: AgentsBundle = { default: "claude", agents: [] };

// A picker option list. `value: null` is the synthetic "Default" head — it
// persists as null in tasks.model/reasoning/permission_mode, inheriting the
// app-level (agent-scoped) default, then the driver's built-in.
export type PickerOption = { value: string | null; label: string; sub: string };
const DEFAULT_HEAD: PickerOption = { value: null, label: "Default", sub: "inherit the agent's default" };
const withDefault = (opts: { value: string; label: string; sub: string }[]): PickerOption[] => [DEFAULT_HEAD, ...opts];
// Build each picker's option list from a driver's capabilities. Undefined caps
// (agent metadata not loaded yet) yields just the Default head.
export const modelOptions = (caps?: AgentCapabilities): PickerOption[] => withDefault(caps?.models ?? []);
export const reasoningOptions = (caps?: AgentCapabilities): PickerOption[] => withDefault(caps?.reasoningOptions ?? []);
export const permissionOptions = (caps?: AgentCapabilities): PickerOption[] => withDefault(caps?.permissionModes ?? []);

// Lightweight filter box for the project & task lists — only worth showing once a
// list grows past SEARCH_MIN, so small workspaces stay clutter-free.
export const SEARCH_MIN = 6;

// Which surface fills the work area (the right two columns). "workspace" is the
// normal tasks+session view; "settings" replaces it with the app settings shell;
// "insights" with the usage/analytics dashboard. Mirrored into the URL
// (?view=settings / ?view=insights) so it's deep-linkable + refresh-stable,
// consistent with how project/task selection is persisted.
export type View = "workspace" | "settings" | "insights";
export interface Tweaks { theme: "light" | "dark"; accent: string; density: string; statusStyle: "dot" | "label"; }
export const DEFAULT_TWEAKS: Tweaks = { theme: "dark", accent: "default", density: "1", statusStyle: "dot" };

// App-level preferences (distinct from Tweaks, which are purely cosmetic). These
// are personal/client-only so they live in the same localStorage store as Tweaks;
// if shared/server config is ever needed, a `settings` table in lib/db.ts keyed by
// name would be the place. Keep this a flat object with sensible defaults so new
// settings are a one-line addition here + a field in SettingsView.
export interface Settings {
  // The app nudges you to /clear when a session's context window crosses EITHER
  // of these — a percentage of the window, or an absolute token count. The paired
  // "Recommend /clear when context is high" feature reads these.
  clearThresholdPct: number;    // 0–100, % of the context window
  clearThresholdTokens: number; // absolute token count
}
export const DEFAULT_SETTINGS: Settings = { clearThresholdPct: 75, clearThresholdTokens: 150_000 };

// Persisted sidebar layout — column widths and collapsed (hidden) state, so the
// user can carve out more room for the chat and have it stick across reloads.
export interface Layout { projW: number; taskW: number; railW: number; projCollapsed: boolean; taskCollapsed: boolean; railCollapsed: boolean; }
export const DEFAULT_LAYOUT: Layout = { projW: 236, taskW: 352, railW: 430, projCollapsed: false, taskCollapsed: false, railCollapsed: false };
export const PROJ_W = { min: 170, max: 460 };
export const TASK_W = { min: 240, max: 620 };
export const RAIL_W = { min: 320, max: 760 };
