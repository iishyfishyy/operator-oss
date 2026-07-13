// Pure formatting + derivation helpers shared across the orchestrator modules.
import type { AskQuestion, AskAnswers } from "@/lib/types";
import type { Msg, TaskRow, AgentCapabilities } from "./types";

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
  }
  // Default (null) model → the driver picks its own; approximate with the widest
  // window it offers so the gauge doesn't over-report fullness.
  const widest = models.reduce((mx, m) => Math.max(mx, m.contextWindow), 0);
  return widest || DEFAULT_CONTEXT_WINDOW;
}
export function contextPct(tokens: number, model: string | null | undefined, caps?: AgentCapabilities): number {
  return Math.round((tokens / contextWindowOf(model, caps)) * 1000) / 10;
}

// Friendly name for a resolved model id. First tries the agent's capability
// models — the id contains one of their values (e.g. "gpt-5.1-codex-max") — and
// uses that option's label. Falls back to the Claude family/version regex
// ("claude-opus-4-8-20251101" -> "Opus 4.8"), then the raw id.
export function modelLabel(id: string | null, caps?: AgentCapabilities): string {
  if (!id) return "";
  const s = id.toLowerCase();
  const hit = (caps?.models ?? []).find((m) => s.includes(m.value.toLowerCase()));
  if (hit) return hit.label;
  const fam = s.includes("fable") ? "Fable" : s.includes("opus") ? "Opus" : s.includes("sonnet") ? "Sonnet" : s.includes("haiku") ? "Haiku" : null;
  if (!fam) return id;
  const m = s.match(/(?:fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/);
  return m ? `${fam} ${m[1]}${m[2] ? `.${m[2]}` : ""}` : fam;
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
