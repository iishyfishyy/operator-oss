// Pure formatting + derivation helpers shared across the orchestrator modules.
import type { AskQuestion, AskAnswers } from "@/lib/types";
import type { Msg, TaskRow, AgentCapabilities, AgentInfo } from "./types";
import type { InternalUsageEstimate } from "./types";

// Compact token count: 1234 → "1.2k", 1_200_000 → "1.2M".
export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}
// Human byte size: 1536 → "1.5 KB", 5_242_880 → "5.0 MB". Base-1024.
export function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${i === 0 ? v : v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
// Dollar cost: sub-cent shows "<$0.01"; otherwise 2–3 sig digits after the point.
export function fmtCost(n: number): string {
  if (n <= 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
}

export function fmtJobCost(e: InternalUsageEstimate): string {
  const cost = e.cost_usd <= 0 ? "$0.00" : e.cost_usd < 0.01 ? "<$0.01" : `$${e.cost_usd.toFixed(2)}`;
  return `~${fmtTokens(e.tokens)} tokens (~${cost})`;
}

// ---------- the usage chip (tokens + cost, honestly) ----------

// A task's cumulative tokens split by what they actually represent. The raw
// `total_tokens` sums all four buckets, and in real sessions ~90%+ of it is
// prompt-cache READS — the same context re-sent on every turn and billed at ~10%
// of the input rate. Leading with that reads as "this task burned 3.8M tokens"
// when the model only ever processed ~250k of new material, which is what scares
// people off. So the chip leads with `fresh` (tokens seen for the first time:
// in/out plus cache WRITES, which are billed above input rate) and carries cache
// reads as secondary detail. Defensive ?? 0s: a task row can predate the fields.
export interface UsageSplit {
  total: number;      // every bucket summed — what task.total_tokens holds
  fresh: number;      // in/out + cache writes: material the model processed anew
  inOut: number;      // prompt + completion tokens, uncached
  cacheWrite: number; // context written into the cache (billed ~1.25× input)
  cacheRead: number;  // context re-read from the cache (billed ~0.1× input)
}
export function usageSplit(t: Pick<TaskRow, "total_tokens" | "cache_read_tokens" | "cache_creation_tokens">): UsageSplit {
  const total = t.total_tokens ?? 0;
  const cacheRead = t.cache_read_tokens ?? 0;
  const cacheWrite = t.cache_creation_tokens ?? 0;
  return { total, cacheRead, cacheWrite, inOut: Math.max(0, total - cacheRead - cacheWrite), fresh: Math.max(0, total - cacheRead) };
}

/**
 * How to present an agent's dollar figure. Two independent questions:
 *
 * - Is the number a MEASUREMENT or an estimate? `costIsEstimated` answers that
 *   (Codex reports tokens only, so its figure is tokens × published prices).
 * - Is the number MONEY THE USER SPENDS? Only under api-key auth. On a Max/Pro
 *   (or ChatGPT) subscription the marginal cost of a turn is $0 — the SDK's
 *   `total_cost_usd` is what the same tokens would have cost through the API,
 *   and what's actually consumed is plan quota. Showing a bare "$4.20" there
 *   reads as a bill for something that was included.
 *
 * Either one makes the figure approximate-in-meaning, so both get an `~` plus a
 * tooltip clause saying which it is. An unknown account (bundle still loading,
 * agent not connected) keeps the plain billed presentation — we won't claim a
 * turn was covered by a plan we can't see.
 */
export interface CostDisplay {
  show: boolean;   // render a dollar figure at all
  approx: boolean; // prefix it with ~
  note: string;    // tooltip clause explaining what the figure means ("" = a plain billed charge)
}
export function costDisplay(agent: AgentInfo | undefined): CostDisplay {
  const caps = agent?.capabilities;
  const estimated = caps?.costIsEstimated === true;
  const show = caps?.reportsCostUsd !== false || estimated;
  const subscription = agent?.account?.method === "subscription";
  const bedrock = agent?.account?.method === "bedrock";
  const plan = agent?.account?.plan;
  // "Max"/"Pro"/"ChatGPT Plus" → "your Max plan"; unknown/"API" → "your plan".
  const planName = plan && !/^api$/i.test(plan) ? `your ${plan} plan` : "your plan";
  const source = estimated ? "estimated from token counts × published API prices" : "API-price equivalent";
  const note = bedrock
    ? "estimated by Claude Code from token usage and published prices; your AWS bill is authoritative"
    : subscription
    ? `${source}: this ran on ${planName} login, so it draws on plan quota, not a bill`
    : estimated
      ? source
      : "";
  return { show, approx: subscription || bedrock || estimated, note };
}

// The usage chip's tooltip: the full breakdown the compact chip can't fit, one
// fact per line. Exact counts here (the chip rounds) — this is the view someone
// opens precisely because the rounded number surprised them.
export function usageTooltip(split: UsageSplit, costUsd: number, cost: CostDisplay): string {
  const n = (v: number) => v.toLocaleString();
  const lines = [
    `${n(split.fresh)} new tokens this task: ${n(split.inOut)} in/out · ${n(split.cacheWrite)} written to cache`,
  ];
  if (split.cacheRead > 0) {
    lines.push(`${n(split.cacheRead)} cache reads (context re-read each turn, billed at ~10% of the input rate)`);
    lines.push(`${n(split.total)} tokens total`);
  }
  if (cost.show && costUsd > 0) {
    lines.push(`${cost.approx ? "~" : ""}${fmtCost(costUsd)}${cost.note ? ` ${cost.note}` : " billed"}`);
  }
  return lines.join("\n");
}

// Context window: the input-side tokens of the latest turn ≈ how full that
// window currently is. The size comes from the agent's capability descriptor
// (capabilities.models[].contextWindow) — Codex windows differ from Claude's, so
// it can't be a static Claude-only table. `caps.models` is looked up by the
// task's configured model value; unknown/Default falls back to the widest model
// the agent offers, then a conservative constant.
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export function contextWindowOf(model: string | null | undefined, caps?: AgentCapabilities): number {
  const models = caps?.models ?? [];
  if (model) {
    const hit = models.find((m) => m.value === model);
    if (hit) return hit.contextWindow;
    const id = model.toLowerCase();
    if (id.includes("[1m]") || id.includes("claude-sonnet-5") || id.includes("claude-fable-5")) return 1_000_000;
    return DEFAULT_CONTEXT_WINDOW;
  }
  // Default (null) model → the driver picks its own; approximate with the widest
  // window it offers so the gauge doesn't over-report fullness.
  const widest = models.reduce((mx, m) => Math.max(mx, m.contextWindow), 0);
  return widest || DEFAULT_CONTEXT_WINDOW;
}
export function contextPct(tokens: number, model: string | null | undefined, caps?: AgentCapabilities): number {
  return Math.round((tokens / contextWindowOf(model, caps)) * 1000) / 10;
}

// Friendly name for a resolved model id — the badge that answers "which model
// did this turn actually run on?". The VERSION is the point: family aliases move
// (today "opus" resolves to claude-opus-5, last month claude-opus-4-8), so a bare
// "Opus" badge tells you nothing. Parse family + version out of the id first
// ("claude-opus-5" -> "Opus 5", "claude-opus-4-8-20251101" -> "Opus 4.8") and
// keep the `[1m]` marker, since the 1M variant is a distinct run mode.
// Non-Claude ids (Codex's "gpt-5.1-codex-max") carry no such version shape —
// those fall through to the agent's capability labels, matched longest-first so
// a shorter value can't shadow a more specific one. Raw id is the last resort.
export function modelLabel(id: string | null, caps?: AgentCapabilities): string {
  if (!id) return "";
  const s = id.toLowerCase();
  const long = s.includes("[1m]") ? " (1M)" : "";
  const fam = ["fable", "opus", "sonnet", "haiku"].find((f) => s.includes(f));
  if (fam) {
    const cap = fam[0].toUpperCase() + fam.slice(1);
    const v = s.match(new RegExp(`${fam}-(\\d+)(?:-(\\d+))?`));
    // Deliberately NOT the capability label here: an id we can't read a version
    // out of shouldn't be badged with a version we're only guessing at.
    return v ? `${cap} ${v[1]}${v[2] ? `.${v[2]}` : ""}${long}` : `${cap}${long}`;
  }
  const hit = (caps?.models ?? [])
    .filter((o) => s.includes(o.value.toLowerCase()))
    .sort((a, b) => b.value.length - a.value.length)[0];
  return hit ? hit.label : id;
}

// Phrase AskUserQuestion answers as a reply, for the reload fallback where the
// turn is no longer parked and we resume the session with a normal message.
export function formatAnswersText(questions: AskQuestion[], answers: AskAnswers): string {
  const lines = questions.map((q, i) => {
    const picked = (answers[i] ?? []).filter((s) => s && s.trim());
    return `- ${q.header || q.question}: ${picked.length ? picked.join(", ") : "(no selection)"}`;
  });
  return `Answering your question${questions.length > 1 ? "s" : ""}:\n${lines.join("\n")}`;
}
// Absolute wall-clock stamp for a transcript message ("3:42 PM", locale-aware).
// Messages from an earlier day prefix the date, so a task resumed days later
// still reads right. Absolute on purpose: MessageView is memoized, so a
// relative "2m ago" would freeze at whatever it said when the row rendered.
export function clockTime(ts: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}
export function relTime(ts: number): string {
  const d = Date.now() - ts;
  const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
// How long a task has been waiting on the user, spelled out for the "need you"
// dropdown ("waiting for 3 hours"). Coarser and more verbose than relTime — this
// is the only subline a row gets, so it reads as prose rather than a chip.
export function waitedFor(since: number): string {
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (s < 45) return "a few seconds";
  const m = Math.round(s / 60);
  if (m < 1) return "a minute";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}
export function duration(start: number, end: number | null): string {
  if (!end) return "active";
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// A task is "waiting on you" when its awaiting_input flag is set — Claude either
// ended its turn mid-task or is parked on an AskUserQuestion. The flag is the
// single source of truth (cleared the instant the next turn starts / a question
// is answered), so this holds even while the turn is technically still live and
// parked on the question — that's exactly the case the task list must surface.
export const isAwaiting = (t: TaskRow) =>
  t.status === "in_progress" && !!t.awaiting_input;

// The titles of a task's unfinished blockers (dependencies not yet 'done'). A
// task with any of these is "blocked" and can't be started until they complete.
// A cancelled dependency doesn't block — it's terminal and will never finish,
// so waiting on it would deadlock the dependent task forever.
export const blockerTitles = (t: TaskRow, byId: Map<string, TaskRow>): string[] =>
  (t.depends_on ?? [])
    .map((id) => byId.get(id))
    .filter((b): b is TaskRow => !!b && b.status !== "done" && b.status !== "cancelled")
    .map((b) => b.title);

// add/del/ctx class for a diff line's sign — shared by the peek and full views.
export const diffCls = (sign: "+" | "-" | " ") => (sign === "+" ? "add" : sign === "-" ? "del" : "ctx");

// group flat messages into per-generation sessions, pulling out the /clear summaries
export function buildSessions(messages: Msg[]) {
  const summaryByGen: Record<number, string> = {};
  for (const m of messages) if (m.role === "session_break") summaryByGen[m.generation] = m.content;
  // Queued follow-ups are excluded here — they haven't run yet, so SessionView
  // renders them in a pinned block below the live "thinking" indicator instead
  // of interleaved with the committed transcript.
  const committed = messages.filter((m) => m.role !== "queued");
  const gens = Array.from(new Set(committed.filter((m) => m.role !== "session_break").map((m) => m.generation))).sort((a, b) => a - b);
  return gens.map((n) => ({
    n,
    summaryBefore: summaryByGen[n - 1] ?? null,
    messages: committed.filter((m) => m.generation === n && m.role !== "session_break"),
  }));
}

// ---------- chat attachments (images + large text pastes) ----------
// An upload travels inside the message text as one marker line per file:
// "[Attached image: /abs/path.png]" for images, "[Attached file: /abs/path.txt]"
// for a big text paste diverted to a file (see PASTE_ATTACH_THRESHOLD). The
// same string serves both sides — Claude Code opens the absolute path with its
// Read tool (rendering images natively, reading text files as text), and the
// transcript strips the marker back out to render an inline thumbnail (image)
// or a file chip (text). The serving URL is derived from the path's
// uploads/<task>/<file> tail, so no extra columns or event fields are needed.
export const attachmentMarker = (absPath: string) => `[Attached image: ${absPath}]`;
export const fileAttachmentMarker = (absPath: string) => `[Attached file: ${absPath}]`;
const ATTACHMENT_RE = /^\[Attached (image|file): (.+)\]$/;

export interface MsgAttachment { path: string; url: string; kind: "image" | "file"; name: string }

// Split a user message into displayable text + attachment chips. Marker lines
// whose path doesn't end in uploads/<task>/<file> (hand-typed lookalikes) stay
// in the text untouched.
export function splitAttachments(content: string): { text: string; attachments: MsgAttachment[] } {
  if (!content.includes("[Attached image: ") && !content.includes("[Attached file: ")) {
    return { text: content, attachments: [] };
  }
  const attachments: MsgAttachment[] = [];
  const kept: string[] = [];
  for (const line of content.split("\n")) {
    const m = ATTACHMENT_RE.exec(line.trim());
    const parts = m ? m[2].split(/[\\/]/).filter(Boolean) : [];
    if (m && parts.length >= 3 && parts[parts.length - 3] === "uploads") {
      const [taskId, file] = parts.slice(-2);
      attachments.push({ path: m[2], url: `/api/tasks/${taskId}/uploads/${file}`, kind: m[1] === "image" ? "image" : "file", name: file });
    } else {
      kept.push(line);
    }
  }
  return { text: kept.join("\n").trim(), attachments };
}
