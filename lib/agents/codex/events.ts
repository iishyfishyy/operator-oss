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
  Usage,
} from "@openai/codex-sdk";

// The SDK's Usage, with every counter optional: the app reads a `codex` binary
// the user installed, which may be older or newer than the SDK types.
type TurnCompletedUsage = Partial<Usage>;
import { clip, summarizeResult, resultText } from "../shared";
import { DEFAULT_CODEX_MODEL } from "./pricing";
import { codexUsage } from "./usage";

// Codex's raw cumulative token counters for a thread, exactly as `turn.completed`
// reports them. Persisted per thread (sessions.usage_cum) so the NEXT turn can
// subtract them — see the delta logic in mapThreadEvent.
export interface CodexCum {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

export const ZERO_CUM: CodexCum = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 };

// Per-turn state threaded through every event: the item ids we've already
// emitted a `tool` event for, the model the turn runs (drives cost estimation on
// turn.completed), the thread's previously-reported cumulative counters (the
// baseline this turn's usage is measured against), and a dirty flag the driver
// watches to persist the new baseline. A fresh object per turn (see newState()).
export interface CodexMapState {
  emittedTool: Set<string>;
  model: string;
  cum: CodexCum;
  cumDirty: boolean;
}

export function newState(model: string = DEFAULT_CODEX_MODEL, cum: CodexCum = ZERO_CUM): CodexMapState {
  return { emittedTool: new Set<string>(), model, cum, cumDirty: false };
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
      // Codex reports the THREAD's running totals here, not this turn's — a
      // resumed thread re-reports everything it has ever spent (turn 2 of a
      // 14k-token thread reports 28k). The StreamEvent contract is per-turn
      // (the runner appends each usage event to the task's cumulative spend),
      // so subtract the baseline the previous turn left behind. Counters that
      // went BACKWARDS mean the report isn't cumulative after all (a thread
      // reset, or an upstream switch to per-turn semantics) — take it at face
      // value then rather than clamping the turn to zero.
      //
      // The three token buckets are kept DISJOINT, as the contract expects
      // (Claude's are): codex folds cached + cache-write tokens into
      // input_tokens, so they're netted out here instead of double-counted in
      // the task total and the context gauge. Reasoning output folds into
      // output_tokens — the API bills reasoning as output.
      //
      // ChatGPT-plan auth reports token counts only, so cost_usd is an
      // ESTIMATE: tokens × published API prices for the turn's model (see
      // ./pricing.ts; capabilities.costIsEstimated makes the UI label it ~).
      const cur = toCum(ev.usage);
      const turn = monotonic(cur, state.cum) ? diffCum(cur, state.cum) : cur;
      state.cum = cur;
      state.cumDirty = true;
      return [{
        type: "usage",
        usage: codexUsage(
          {
            input_tokens: turn.input,
            cached_input_tokens: turn.cachedInput,
            cache_write_input_tokens: turn.cacheWrite,
            output_tokens: turn.output,
            reasoning_output_tokens: turn.reasoning,
          },
          state.model
        ),
      }];
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
  // ask_user is rendered as an interactive card published directly by the
  // internal ask-user endpoint (lib/agentTools.startAskUser) — suppress the
  // generic tool line so the question isn't shown twice (mirrors the Claude
  // driver skipping AskUserQuestion tool_use blocks).
  if (item.server === "orchestrator" && item.tool === "ask_user") return [];
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

// ---------- cumulative-usage helpers ----------

function toCum(u: TurnCompletedUsage): CodexCum {
  return {
    input: u.input_tokens ?? 0,
    cachedInput: u.cached_input_tokens ?? 0,
    // Added to the SDK's Usage after the driver shipped; treat as optional so an
    // older/newer CLI that omits it prices as plain input rather than crashing.
    cacheWrite: u.cache_write_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    reasoning: u.reasoning_output_tokens ?? 0,
  };
}

// Is this report still counting up from the baseline? Decided on the INPUT side:
// it's the dominant counter, it can only grow while a thread lives, and it's the
// one a migrated/backfilled baseline records exactly (the output-side split
// between plain and reasoning tokens isn't always recoverable). Input going
// backwards means the baseline doesn't belong to this run of the thread.
const monotonic = (cur: CodexCum, prev: CodexCum): boolean =>
  cur.input >= prev.input && cur.cachedInput >= prev.cachedInput && cur.cacheWrite >= prev.cacheWrite;

// Per-field, floored at zero: a baseline that's slightly high on one counter
// costs that counter a turn, never a negative charge.
const diffCum = (cur: CodexCum, prev: CodexCum): CodexCum => ({
  input: Math.max(0, cur.input - prev.input),
  cachedInput: Math.max(0, cur.cachedInput - prev.cachedInput),
  cacheWrite: Math.max(0, cur.cacheWrite - prev.cacheWrite),
  output: Math.max(0, cur.output - prev.output),
  reasoning: Math.max(0, cur.reasoning - prev.reasoning),
});

// ---------- small helpers ----------

const firstLine = (s: string): string => s.split("\n")[0].slice(0, 70);
const basename = (p: string): string => p.split("/").filter(Boolean).slice(-1)[0] ?? p;

function linesPeek(text: string): ToolPeek {
  const MAX = 6;
  const lines = text.split("\n").filter((l) => l.trim());
  return { kind: "lines", lines: lines.slice(0, MAX), truncated: Math.max(0, lines.length - MAX) };
}
