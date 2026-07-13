"use client";

import { useState } from "react";
import type { ToolData, ToolPeek, AskQuestion, AskAnswers } from "@/lib/types";
import { Icon } from "../icons";
import { Markdown } from "../Markdown";
import { diffCls, splitAttachments, type MsgAttachment } from "./format";
import { CONTEXT_OVERFLOW_NOTICE } from "@/lib/promptLimits";
import type { Msg } from "./types";
import { Avatar } from "./shared";

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

export function MessageView({ m, initial, hideWho, running, agentLabel = "The agent", onAnswer, onCancelQueued, onClear }: { m: Msg; initial: boolean; hideWho: boolean; running?: boolean; agentLabel?: string; onAnswer?: (askId: string, questions: AskQuestion[], answers: AskAnswers) => void; onCancelQueued?: (pendingId: string) => void; onClear?: () => void }) {
  if (m.role === "queued") {
    // A follow-up the user typed mid-turn, waiting its turn. Reads like a user
    // bubble but dimmed, tagged "Queued", with an × to drop it before it runs.
    const { text, attachments } = splitAttachments(m.content);
    return (
      <div className="msg user queued">
        <div className="who"><Avatar who="user" /> You<span className="badge queued-badge">queued</span></div>
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
            ⚠ {m.content}
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
    // Notes that already carry their own glyph (✓/ℹ — e.g. the "caught up to main"
    // sync note) render quietly; everything else is a warning and gets the ⚠.
    const info = /^[✓ℹ]/.test(m.content);
    return <div className={`msg system${info ? " info" : ""}`}><div className="msg-body">{info ? m.content : `⚠ ${m.content}`}</div></div>;
  }
  const isUser = m.role === "user";
  // Only user messages carry attachment markers; assistant text passes through.
  const { text, attachments } = isUser ? splitAttachments(m.content) : { text: m.content, attachments: [] };
  return (
    <div className={`msg ${isUser ? "user" : "assistant"} ${initial ? "initial" : ""}`}>
      {!hideWho && (
        <div className="who">
          <Avatar who={isUser ? "user" : "cc"} />
          {isUser ? "You" : "Agent"}
          {initial && <span className="badge">initial prompt</span>}
        </div>
      )}
      <div className="msg-body">
        {initial && <div className="initial-tag">{Icon.spark()} sent with project context</div>}
        {text && <Markdown>{text}</Markdown>}
        <AttachmentStrip items={attachments} />
      </div>
    </div>
  );
}

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
