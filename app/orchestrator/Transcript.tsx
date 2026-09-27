"use client";

import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ToolData, ToolPeek, ToolSuggestion, AskQuestion, AskAnswers } from "@/lib/types";
import { Icon } from "../icons";
import { Markdown } from "../Markdown";
import { clockTime, diffCls, splitAttachments, type MsgAttachment } from "./format";
import { CONTEXT_OVERFLOW_NOTICE } from "@/lib/promptLimits";
import { AUTH_EXPIRED_NOTICE } from "@/lib/authFailure";
import { USAGE_LIMIT_NOTICE } from "@/lib/usageLimit";
import { APPROVAL_BLOCKED_NOTICE } from "@/lib/approvalFailure";
import type { Msg, TaskRow } from "./types";
import type { SuggestionCard } from "./suggestions";
import { Avatar } from "./shared";

// ---------- suggestion chips ----------
//
// A suggest_task tool card renders as a LIVE chip rather than a frozen tool
// line: the created task's current title (read from the project's task list, so
// a rename made in the tray or the edit modal shows here too), click-to-rename,
// the edit modal, and the tray's own Add / Start / Dismiss — so a batch of
// suggestions can be curated from the session that proposed them without
// leaving the transcript. The task list and handlers arrive through a context
// rather than props: MessageView is memoized on the message alone, and only the
// chips (never the surrounding transcript) should re-render when tasks change.
export interface SuggestionActions {
  /** The selected project's tasks (real + suggested), by id. */
  byId: Map<string, TaskRow>;
  /** False until the task list has loaded — before that "missing" means nothing yet. */
  ready: boolean;
  onRename: (id: string, title: string) => void;
  onEdit: (id: string) => void;
  onAccept: (id: string) => void;
  onStart: (id: string) => void;
  onDismiss: (id: string) => void;
  /** Jump to a suggestion that has since been added / started. */
  onOpen: (id: string) => void;
}
export const SuggestionContext = createContext<SuggestionActions | null>(null);

/**
 * Build the context value: the by-id index is memoized on the task list and the
 * handlers are ref-backed, so the value (and every chip) only re-renders when
 * the tasks actually change — the shell passes fresh inline handlers per render.
 */
export function useSuggestionActions(tasks: TaskRow[], ready: boolean, handlers: Omit<SuggestionActions, "byId" | "ready">): SuggestionActions {
  const ref = useRef(handlers);
  ref.current = handlers;
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  return useMemo(
    () => ({
      byId,
      ready,
      onRename: (id, title) => ref.current.onRename(id, title),
      onEdit: (id) => ref.current.onEdit(id),
      onAccept: (id) => ref.current.onAccept(id),
      onStart: (id) => ref.current.onStart(id),
      onDismiss: (id) => ref.current.onDismiss(id),
      onOpen: (id) => ref.current.onOpen(id),
    }),
    [byId, ready]
  );
}

const STATUS_BADGE: Record<string, string> = {
  not_started: "added",
  in_progress: "in progress",
  on_hold: "on hold",
  in_review: "in review",
  done: "done",
  cancelled: "cancelled",
};

// The chip's states, resolved against the task list:
//   tray      — still a suggestion: rename, Edit…, Add, Start, Dismiss
//   accepted  — added or started: rename, Edit…, its status, Open
//   pending   — created moments ago by the live turn; the list hasn't caught up
//   gone      — hard-deleted (dismissed from anywhere): greyed, read-only
//   unknown   — no task list yet (loading) or no provider: title only
type ChipState = "tray" | "accepted" | "pending" | "gone" | "unknown";

// How long after a card lands a missing task still reads as "adding…" rather
// than "dismissed" while its turn runs. The `suggested` event's task-list reload
// is in flight for milliseconds; the window just has to outlast it, and stay
// short enough that a card from an earlier turn never borrows the excuse.
const PENDING_WINDOW_MS = 30_000;

export function SuggestionChip({ suggestion, running, ts }: { suggestion: ToolSuggestion; running?: boolean; ts?: number }) {
  const ctx = useContext(SuggestionContext);
  const taskId = suggestion.taskId;
  const task = taskId && ctx ? ctx.byId.get(taskId) : undefined;
  const justFiled = !!running && (ts == null || Date.now() - ts < PENDING_WINDOW_MS);
  const state: ChipState = task
    ? task.suggested ? "tray" : "accepted"
    : !ctx || !ctx.ready || !taskId ? "unknown"
    : justFiled ? "pending" : "gone";
  const title = task?.title || suggestion.title || "(untitled)";
  const canEdit = !!ctx && !!taskId && (state === "tray" || state === "accepted");

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);
  const begin = () => {
    if (!canEdit) return;
    setDraft(title);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== title && taskId) ctx?.onRename(taskId, next);
  };

  const badge =
    state === "gone" ? "dismissed"
    : state === "pending" ? "adding…"
    : state === "accepted" && task ? STATUS_BADGE[task.status] ?? task.status
    : null;

  return (
    <div className={`sug-chip is-${state}`} data-task-id={taskId}>
      <span className="sug-chip-glyph" aria-hidden>✦</span>
      {editing ? (
        <input
          ref={inputRef}
          className="sug-chip-input"
          value={draft}
          autoFocus
          aria-label="Task title"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            else if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
          }}
        />
      ) : (
        <button className="sug-chip-title" onClick={begin} disabled={!canEdit} title={canEdit ? "Click to rename" : undefined}>
          {title}
        </button>
      )}
      {badge && <span className="sug-chip-badge">{badge}</span>}
      {canEdit && ctx && taskId && (
        <span className="sug-chip-actions">
          <button className="sug-dismiss" title="Edit title & description" aria-label="Edit task" onClick={() => ctx.onEdit(taskId)}>{Icon.edit()}</button>
          {state === "tray" ? (
            <>
              <button className="sug-add" title="Add to task list to start later" onClick={() => ctx.onAccept(taskId)}>{Icon.plus()} Add</button>
              <button className="sug-btn" onClick={() => ctx.onStart(taskId)}>{Icon.play()} Start</button>
              <button className="sug-dismiss" title="Dismiss" aria-label="Dismiss suggestion" onClick={() => ctx.onDismiss(taskId)}>{Icon.x()}</button>
            </>
          ) : (
            <button className="sug-add" title="Open this task" onClick={() => ctx.onOpen(taskId)}>{Icon.external()} Open</button>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * The "Suggested this session" summary: rendered after the last message of a
 * turn that filed two or more suggestions (see suggestionBatches), listing all
 * of them as one compact, collapsible unit — the place to fix five titles in a
 * row after a planning turn. The same chips as the inline cards, so both stay
 * in step by construction.
 */
export function SuggestionBatch({ cards, running }: { cards: SuggestionCard[]; running?: boolean }) {
  const [open, setOpen] = useState(true);
  const n = cards.length;
  return (
    <div className="sug-batch">
      <button className="sug-batch-h" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={open ? "Collapse" : `Show ${n} suggestions`}>
        {Icon.chevDown({ className: `sb-chev ${open ? "" : "closed"}` })}
        {Icon.spark()} Suggested this session
        <span className="sb-count">{n} task{n === 1 ? "" : "s"}</span>
      </button>
      {open && (
        <div className="sug-batch-list">
          {cards.map((c) => <SuggestionChip key={c.msgId} suggestion={c.suggestion} running={running} ts={c.ts} />)}
        </div>
      )}
    </div>
  );
}

// The always-visible "peek" tier — Claude Code's `⎿` line. Counts show no
// content; diffs/snippets show a capped hunk with a clickable "+N more" that
// opens the full body. TodoWrite renders its checklist inline.
function PeekView({ peek, expandable, onExpand }: { peek: ToolPeek; expandable: boolean; onExpand: () => void }) {
  const corner = <span className="tcorner">⎿</span>;
  if (peek.kind === "count") {
    return (
      <button className="tpeek tpeek-count" style={{ cursor: expandable ? "pointer" : "default" }} onClick={() => expandable && onExpand()}>
        {corner}<span className="tpeek-txt">{peek.text}</span>
        {expandable && <span className="tpeek-more">expand</span>}
      </button>
    );
  }
  if (peek.kind === "todos") {
    return (
      <div className="tpeek tpeek-todos">
        {peek.items.map((t, i) => (
          <div className={`tdo ${t.status}`} key={i}>
            <span className="tdo-box">{t.status === "completed" ? "✔" : t.status === "in_progress" ? "▣" : "▢"}</span>
            <span className="tdo-txt">{t.text}</span>
          </div>
        ))}
      </div>
    );
  }
  if (peek.kind === "diff") {
    return (
      <div className="tpeek tpeek-diff">
        <div className="tpeek-sum">{corner}<span className="dstat add">+{peek.added}</span><span className="dstat del">−{peek.removed}</span>{peek.label && <span className="tpeek-txt">{peek.label}</span>}</div>
        <pre className="tpeek-pre diff">{peek.lines.map((l, i) => <div className={`dl ${diffCls(l.sign)}`} key={i}>{l.sign} {l.text}</div>)}</pre>
        {peek.truncated ? <button className="tpeek-more btn-link" onClick={onExpand}>+{peek.truncated} more lines</button> : null}
      </div>
    );
  }
  // lines (Bash output)
  return (
    <div className="tpeek tpeek-lines">
      {peek.label && <div className="tpeek-sum">{corner}<span className="tpeek-txt">{peek.label}</span></div>}
      <pre className="tpeek-pre">{peek.lines.join("\n") || "(no output)"}</pre>
      {peek.truncated ? <button className="tpeek-more btn-link" onClick={onExpand}>+{peek.truncated} more lines</button> : null}
    </div>
  );
}

function ToolView({ data }: { data: ToolData }) {
  const [open, setOpen] = useState(false);
  const hasDiff = !!data.diff?.length;
  const expandable = !!(data.detail || hasDiff || data.result !== undefined);
  // Failures surface their output automatically, like Claude Code.
  const showBody = open || (!!data.isError && data.result !== undefined);
  return (
    <div className="tool">
      <button className="tool-h" style={{ cursor: expandable ? "pointer" : "default" }} onClick={() => expandable && setOpen((o) => !o)}>
        {expandable && <span className={`tchev ${showBody ? "open" : ""}`}>{Icon.chevRight()}</span>}
        <span className="tg">{data.title}</span>
        {data.result !== undefined && <span className={data.isError ? "tx" : "tcheck"}>{data.isError ? Icon.x() : Icon.check()}</span>}
      </button>
      {data.peek && !showBody && <PeekView peek={data.peek} expandable={expandable} onExpand={() => setOpen(true)} />}
      {showBody && (
        <div className="tool-body">
          {data.detail && <pre className="tool-pre">{data.detail}</pre>}
          {hasDiff && (
            <pre className="tool-pre diff">{data.diff!.map((l, i) => <div className={`dl ${diffCls(l.sign)}`} key={i}>{l.sign} {l.text}</div>)}</pre>
          )}
          {data.result !== undefined && (
            <>
              {(data.detail || hasDiff) && <div className="tool-divider">result</div>}
              <pre className={`tool-pre ${data.isError ? "err" : ""}`}>{data.result || "(no output)"}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Interactive AskUserQuestion card: option pickers (+ an "Other" free-text per
// question) while pending; a read-only summary once answered.
function AskView({ data, agentLabel, onAnswer }: { data: ToolData; agentLabel: string; onAnswer: (answers: AskAnswers) => void }) {
  const questions = data.ask?.questions ?? [];
  const existing = data.ask?.answers;
  const [state, setState] = useState(() => questions.map(() => ({ picked: [] as string[], other: "" })));
  const [submitted, setSubmitted] = useState(false);

  if (existing) {
    return (
      <div className="ask answered">
        <div className="ask-head">{Icon.spark()} You answered</div>
        {questions.map((q, i) => (
          <div className="ask-q" key={i}>
            <div className="ask-qh"><span className="ask-chip">{q.header}</span>{q.question}</div>
            <div className="ask-picked">{(existing[i] ?? []).join(", ") || "—"}</div>
          </div>
        ))}
      </div>
    );
  }

  const toggle = (qi: number, label: string, multi: boolean) =>
    setState((s) => s.map((st, i) => {
      if (i !== qi) return st;
      if (multi) {
        const has = st.picked.includes(label);
        return { ...st, picked: has ? st.picked.filter((l) => l !== label) : [...st.picked, label] };
      }
      return { picked: [label], other: "" }; // single-select replaces, clears Other
    }));
  const setOther = (qi: number, v: string) =>
    setState((s) => s.map((st, i) => (i === qi ? (questions[i].multiSelect ? { ...st, other: v } : { picked: [], other: v }) : st)));

  const answers: AskAnswers = state.map((st) => [...st.picked, ...(st.other.trim() ? [st.other.trim()] : [])]);
  const complete = answers.every((a) => a.length > 0);
  const submit = () => { if (complete && !submitted) { setSubmitted(true); onAnswer(answers); } };

  return (
    <div className="ask">
      <div className="ask-head">{Icon.spark()} {agentLabel} needs your input</div>
      {questions.map((q, i) => (
        <div className="ask-q" key={i}>
          <div className="ask-qh"><span className="ask-chip">{q.header}</span>{q.question}{q.multiSelect && <span className="ask-multi">pick any</span>}</div>
          <div className="ask-opts">
            {q.options.map((o) => (
              <button key={o.label} className={`ask-opt ${state[i].picked.includes(o.label) ? "on" : ""}`} onClick={() => toggle(i, o.label, !!q.multiSelect)} disabled={submitted}>
                <span className="ask-opt-l">{o.label}</span>
                {o.description && <span className="ask-opt-d">{o.description}</span>}
              </button>
            ))}
            <input className="ask-other" placeholder="Other…" value={state[i].other} disabled={submitted} onChange={(e) => setOther(i, e.target.value)} />
          </div>
        </div>
      ))}
      <div className="ask-foot">
        <button className="btn btn-accent btn-sm" onClick={submit} disabled={!complete || submitted}>{submitted ? "Sending…" : "Send answer"}</button>
      </div>
    </div>
  );
}

// Attachment chips parsed out of a user message's markers: image thumbnails
// (click opens full size) and text-file chips (a big paste diverted to a file;
// click opens it). Both are served from the task's uploads dir.
function AttachmentStrip({ items }: { items: MsgAttachment[] }) {
  if (!items.length) return null;
  return (
    <div className="msg-attachments">
      {items.map((a, i) =>
        a.kind === "image" ? (
          <a key={i} href={a.url} target="_blank" rel="noreferrer" title="Open full size">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={a.url} alt="attached image" loading="lazy" />
          </a>
        ) : (
          <a key={i} href={a.url} target="_blank" rel="noreferrer" className="file-chip" title={`Open ${a.name}`}>
            {Icon.clip()} <span>attached file</span>
          </a>
        )
      )}
    </div>
  );
}

// Memoized: during a live turn every SSE event re-renders the transcript's
// parents, but message objects are append-only (replaced only when their content
// changes), so unchanged messages skip re-rendering — and re-parsing their
// markdown — entirely. Callers must pass identity-stable handlers or the memo
// is defeated (SessionView wraps its handlers for exactly this reason).
export const MessageView = memo(function MessageView({ m, initial, hideWho, running, agent, agentLabel = "The agent", onAnswer, onCancelQueued, onClear, onReconnect, onRetry }: { m: Msg; initial: boolean; hideWho: boolean; running?: boolean; agent?: string | null; agentLabel?: string; onAnswer?: (askId: string, questions: AskQuestion[], answers: AskAnswers) => void; onCancelQueued?: (pendingId: string) => void; onClear?: () => void; onReconnect?: () => void; onRetry?: (msgId: string) => void }) {
  if (m.role === "queued") {
    // A follow-up the user typed mid-turn, waiting its turn. Reads like a user
    // bubble but dimmed, tagged "Queued", with an × to drop it before it runs.
    const { text, attachments } = splitAttachments(m.content);
    return (
      <div className="msg user queued">
        <div className="who"><Avatar who="user" /> You<span className="badge queued-badge">queued</span>{m.ts != null && <span className="msg-time">{clockTime(m.ts)}</span>}</div>
        <div className="msg-body">
          {text && <Markdown>{text}</Markdown>}
          <AttachmentStrip items={attachments} />
          {onCancelQueued && <button className="queued-x" title="Remove from queue" aria-label="Remove from queue" onClick={() => onCancelQueued(m.id)}>{Icon.x()}</button>}
        </div>
      </div>
    );
  }
  if (m.role === "tool") {
    let data: ToolData;
    try { data = JSON.parse(m.content) as ToolData; } catch { data = { title: m.content }; }
    if (data.ask) {
      return <div className="msg msg-tool"><AskView data={data} agentLabel={agentLabel} onAnswer={(answers) => onAnswer?.(data.ask?.id || m.toolId || "", data.ask?.questions ?? [], answers)} /></div>;
    }
    // A suggest_task call that created a task renders as its live chip. One
    // that didn't (the project vanished mid-turn — or a card persisted before
    // the id was carried) keeps the plain tool line with its result text.
    if (data.suggestion?.taskId) {
      return <div className="msg msg-tool"><SuggestionChip suggestion={data.suggestion} running={running} ts={m.ts} /></div>;
    }
    return <div className="msg msg-tool"><ToolView data={data} /></div>;
  }
  if (m.role === "system") {
    // A context-overflow failure: render the warning line plus a one-click path
    // to /clear, which resets the poisoned session and starts a fresh window
    // (carrying a summary over). The notice string is matched verbatim — it's
    // the durable, reconnect-safe channel written by lib/runner.ts.
    if (m.content.includes(CONTEXT_OVERFLOW_NOTICE)) {
      return (
        <div className="msg system overflow">
          <div className="msg-body">
            {m.content}
            {onClear && (
              <div className="overflow-actions">
                <button className="btn btn-sm" onClick={onClear} disabled={running} title="Save a summary and start a fresh context window">
                  {Icon.clear()} Start fresh context
                </button>
              </div>
            )}
          </div>
        </div>
      );
    }
    // The agent's login died: same shape as the overflow case — the warning line
    // plus the one action that fixes it (Settings → Agents, where the connect
    // flow lives). Instance-wide, so the titlebar banner says it too; this is
    // the in-context copy for whoever is reading the failed task.
    if (m.content.includes(AUTH_EXPIRED_NOTICE)) {
      return (
        <div className="msg system overflow">
          <div className="msg-body">
            {m.content}
            {onReconnect && (
              <div className="overflow-actions">
                <button className="btn btn-sm" onClick={onReconnect} title={`Sign in to ${agentLabel} again`}>
                  {Icon.bolt()} Reconnect {agentLabel}
                </button>
              </div>
            )}
          </div>
        </div>
      );
    }
    // The agent's usage limit is spent: same shape as the two cases above, but
    // the only recovery is waiting for the reset (the error line above the
    // notice carries the reset time when the SDK reported one), so this renders
    // the notice styled like the others with no action button.
    if (m.content.includes(USAGE_LIMIT_NOTICE)) {
      return (
        <div className="msg system overflow">
          <div className="msg-body">{m.content}</div>
        </div>
      );
    }
    // The approval policy blocked the turn (enterprise-managed Codex downgraded
    // the driver's "never" to an approval-requiring policy that exec mode can't
    // service): same shape as the cases above, with a Retry button — the driver
    // already switched future turns to the compatible "on-request" policy, so
    // resending the failed message is the recovery (see lib/approvalFailure.ts).
    if (m.content.includes(APPROVAL_BLOCKED_NOTICE)) {
      return (
        <div className="msg system overflow">
          <div className="msg-body">
            {m.content}
            {onRetry && (
              <div className="overflow-actions">
                <button className="btn btn-sm" onClick={() => onRetry(m.id)} disabled={running} title="Send the failed message again">
                  {Icon.bolt()} Retry
                </button>
              </div>
            )}
          </div>
        </div>
      );
    }
    // Notes that already carry their own glyph (✓/ℹ — e.g. the "caught up to main"
    // sync note) render quietly; anything else is a warning. The runner's error
    // lines arrive with their own ⚠ already, so only glyph-less content gets one
    // (prepending unconditionally used to render "⚠ ⚠ …").
    const info = /^[✓ℹ]/.test(m.content);
    const glyphed = info || m.content.startsWith("⚠");
    return <div className={`msg system${info ? " info" : ""}`}><div className="msg-body">{glyphed ? m.content : `⚠ ${m.content}`}</div></div>;
  }
  const isUser = m.role === "user";
  // Only user messages carry attachment markers; assistant text passes through.
  const { text, attachments } = isUser ? splitAttachments(m.content) : { text: m.content, attachments: [] };
  return (
    <div className={`msg ${isUser ? "user" : "assistant"} ${initial ? "initial" : ""}`}>
      {!hideWho && (
        <div className="who">
          <Avatar who={isUser ? "user" : "cc"} agent={agent} />
          {isUser ? "You" : "Agent"}
          {initial && <span className="badge">task</span>}
          {m.ts != null && <span className="msg-time">{clockTime(m.ts)}</span>}
        </div>
      )}
      <div className="msg-body">
        {initial && <div className="initial-tag">{Icon.spark()} sent with project context</div>}
        {text && <Markdown>{text}</Markdown>}
        <AttachmentStrip items={attachments} />
      </div>
    </div>
  );
});

export function SessionBreak({ summary }: { summary: string }) {
  return (
    <div className="sbreak">
      <span className="ln" />
      <div className="card">
        <div className="cl">{Icon.clear()} context cleared · summary saved</div>
        <div className="ct">{summary}</div>
      </div>
      <span className="ln" />
    </div>
  );
}
