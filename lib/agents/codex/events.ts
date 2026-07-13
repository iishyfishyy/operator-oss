// The Codex event normalizer — pure functions that turn the codex CLI's JSONL
// `ThreadEvent` stream (surfaced by @openai/codex-sdk) into the agent-agnostic
// StreamEvent contract (lib/types.ts). Kept separate from driver.ts so it can
// be unit-tested against recorded JSONL fixtures without spawning the CLI.
//
// Codex emits *items* through a lifecycle — item.started → item.updated* →
// item.completed — reusing a stable `item.id` across the phases. The runner
// keys tool messages by that id (a second `tool` event with the same id would
// create a duplicate row), so we emit exactly one `tool` event per item on its
// first sighting and fold every later update into `tool_result` events, which
// update the same row in place (matching the Claude driver's tool/tool_result
// pairing).

import type { StreamEvent, ToolPeek } from "../../types";
import type {
  ThreadEvent,
  ThreadItem,
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  TodoListItem,
} from "@openai/codex-sdk";
import { clip, summarizeResult, resultText } from "../shared";

// Per-turn state threaded through every event: the item ids we've already
// emitted a `tool` event for. A fresh object per turn (see newState()).
export interface CodexMapState {
  emittedTool: Set<string>;
}

export function newState(): CodexMapState {
  return { emittedTool: new Set<string>() };
}

const ITEM_PHASES = new Set(["item.started", "item.updated", "item.completed"]);
type ItemPhase = "started" | "updated" | "completed";

/**
 * Map one top-level codex ThreadEvent to zero or more StreamEvents. `state`
 * carries the emitted-tool set across the turn's events and is mutated in place.
 */
export function mapThreadEvent(ev: ThreadEvent, state: CodexMapState): StreamEvent[] {
  switch (ev.type) {
    case "thread.started":
      // The thread id is the opaque session id — persisted (tasks.session_id)
      // and handed back verbatim on resume, exactly like a Claude session id.
      return [{ type: "session", sessionId: ev.thread_id }];
    case "turn.completed": {
      // ChatGPT-plan auth reports no dollar cost, so cost_usd is always 0
      // (capabilities.reportsCostUsd=false hides the $ in the UI). Reasoning
      // output is folded into output_tokens so the context gauge reflects true
      // spend; codex has no cache-creation counter (cache_creation_tokens=0).
      const u = ev.usage;
      return [
        {
          type: "usage",
          usage: {
            cost_usd: 0,
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens + u.reasoning_output_tokens,
            cache_read_tokens: u.cached_input_tokens,
            cache_creation_tokens: 0,
          },
        },
      ];
    }
    case "turn.failed":
      // A model/turn failure (distinct from a Stop, which kills the process and
      // never reaches here — see the driver's abort handling).
      return [{ type: "error", content: ev.error.message }];
    case "error":
      // A fatal, unrecoverable stream error.
      return [{ type: "error", content: ev.message }];
    default:
      if (ITEM_PHASES.has(ev.type)) {
        const phase = ev.type.slice("item.".length) as ItemPhase;
        return mapItem(phase, (ev as { item: ThreadItem }).item, state);
      }
      // turn.started and any future event type: nothing to render.
      return [];
  }
}

function mapItem(phase: ItemPhase, item: ThreadItem, state: CodexMapState): StreamEvent[] {
  switch (item.type) {
    case "agent_message":
      // The assistant's natural-language reply arrives complete on the item's
      // terminal event. (A turn can have several — codex narrates between steps.)
      return phase === "completed" && item.text.trim() ? [{ type: "assistant", content: item.text }] : [];
    case "reasoning":
      // Rendered as a collapsed tool line (there is no distinct "thinking"
      // StreamEvent). Emitted once, on completion, with the full summary.
      return phase === "completed" && item.text.trim()
        ? [toolOnce(state, item.id, { title: "🧠 Thinking", detail: clip(item.text), peek: linesPeek(item.text) })].filter(nonEmpty)
        : [];
    case "command_execution":
      return mapCommand(phase, item, state);
    case "file_change":
      return mapFileChange(phase, item, state);
    case "mcp_tool_call":
      return mapMcp(phase, item, state);
    case "web_search":
      // A single tool line; the query is known as soon as the search starts.
      return [toolOnce(state, item.id, { title: `🔎 Web search: ${item.query}`, detail: item.query })].filter(nonEmpty);
    case "todo_list":
      return mapTodo(phase, item, state);
    case "error":
      // A non-fatal error surfaced as an item.
      return [{ type: "error", content: item.message }];
    default:
      return [];
  }
}

// Emit a `tool` event for `id` only the first time we see it; later sightings
// return an empty sentinel the caller filters out. Returns the event | null so
// callers can inline it; use nonEmpty() to drop the null.
function toolOnce(
  state: CodexMapState,
  id: string,
  fields: { title: string; detail: string; peek?: ToolPeek }
): StreamEvent {
  if (state.emittedTool.has(id)) return EMPTY;
  state.emittedTool.add(id);
  return { type: "tool", id, title: fields.title, detail: fields.detail, peek: fields.peek };
}

// A "no event" marker used by toolOnce; filtered by nonEmpty(). Kept as a typed
// StreamEvent so callers stay in an array of StreamEvent.
const EMPTY = { type: "notice", content: "" } as const;
const nonEmpty = (ev: StreamEvent): boolean => !(ev.type === "notice" && ev.content === "");

function mapCommand(phase: ItemPhase, item: CommandExecutionItem, state: CodexMapState): StreamEvent[] {
  const out: StreamEvent[] = [];
  const tool = toolOnce(state, item.id, { title: `❯ ${firstLine(item.command)}`, detail: clip(item.command) });
  if (nonEmpty(tool)) out.push(tool);
  if (phase === "completed") {
    const raw = item.aggregated_output ?? "";
    const isError = item.status === "failed" || (item.exit_code != null && item.exit_code !== 0);
    out.push({
      type: "tool_result",
      id: item.id,
      content: clip(raw, 6000),
      isError,
      peek: summarizeResult("output", raw),
    });
  }
  return out;
}

// Codex reports the *set of changed paths* (path + add/delete/update), not a
// content diff, so we render a git-status-style file list rather than a +/-
// hunk. A failed patch also emits an error tool_result so the failure is legible.
function mapFileChange(phase: ItemPhase, item: FileChangeItem, state: CodexMapState): StreamEvent[] {
  const out: StreamEvent[] = [];
  const tool = toolOnce(state, item.id, describeFileChange(item.changes));
  if (nonEmpty(tool)) out.push(tool);
  if (phase === "completed" && item.status === "failed") {
    out.push({ type: "tool_result", id: item.id, content: "Patch failed", isError: true });
  }
  return out;
}

const CHANGE_LETTER: Record<FileChangeItem["changes"][number]["kind"], string> = { add: "A", update: "M", delete: "D" };
const CHANGE_VERB: Record<FileChangeItem["changes"][number]["kind"], string> = { add: "Create", update: "Edit", delete: "Delete" };

function describeFileChange(changes: FileChangeItem["changes"]): { title: string; detail: string; peek: ToolPeek } {
  const MAX = 14;
  const lines = changes.map((c) => `${CHANGE_LETTER[c.kind] ?? "?"}  ${c.path}`);
  const title =
    changes.length === 1
      ? `✎ ${CHANGE_VERB[changes[0].kind] ?? "Change"} ${basename(changes[0].path)}`
      : `✎ Edited ${changes.length} files`;
  return {
    title,
    detail: changes.map((c) => c.path).join("\n"),
    peek: { kind: "lines", lines: lines.slice(0, MAX), truncated: Math.max(0, lines.length - MAX) },
  };
}

function mapMcp(phase: ItemPhase, item: McpToolCallItem, state: CodexMapState): StreamEvent[] {
  const out: StreamEvent[] = [];
  const tool = toolOnce(state, item.id, { title: `⚙ ${item.server}: ${item.tool}`, detail: clip(item.arguments) });
  if (nonEmpty(tool)) out.push(tool);
  if (phase === "completed") {
    const isError = item.status === "failed" || !!item.error;
    const content = item.error ? item.error.message : resultText(item.result?.content);
    out.push({
      type: "tool_result",
      id: item.id,
      content: clip(content, 6000),
      isError,
      peek: isError ? undefined : summarizeResult("output", content),
    });
  }
  return out;
}

// The running plan. Emitted once as a `tool` with a todos peek, then refreshed
// in place via `tool_result` on every subsequent update so the checklist ticks
// off live on a single message (mirrors Claude's TodoWrite peek).
function mapTodo(_phase: ItemPhase, item: TodoListItem, state: CodexMapState): StreamEvent[] {
  const peek: ToolPeek = {
    kind: "todos",
    items: item.items.map((t) => ({ text: t.text, status: t.completed ? "completed" : "pending" })),
  };
  if (!state.emittedTool.has(item.id)) {
    state.emittedTool.add(item.id);
    return [{ type: "tool", id: item.id, title: "☑ Plan", detail: "", peek }];
  }
  return [{ type: "tool_result", id: item.id, content: "", isError: false, peek }];
}

// ---------- small helpers ----------

const firstLine = (s: string): string => s.split("\n")[0].slice(0, 70);
const basename = (p: string): string => p.split("/").filter(Boolean).slice(-1)[0] ?? p;

function linesPeek(text: string): ToolPeek {
  const MAX = 6;
  const lines = text.split("\n").filter((l) => l.trim());
  return { kind: "lines", lines: lines.slice(0, MAX), truncated: Math.max(0, lines.length - MAX) };
}
