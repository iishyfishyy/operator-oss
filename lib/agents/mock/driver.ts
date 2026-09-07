// The e2e mock driver — a deterministic AgentDriver used only by the Playwright
// suite (registered when ORCH_E2E_MOCK_AGENT=1, see registry.ts). It exercises
// the full turn contract (session/model/tool/assistant/usage/done, plus error,
// suggested, and abort-aware sleeps) without any real agent CLI or login, so
// e2e runs need no Claude/Codex credentials and produce the same transcript
// every time.
//
// Turn behavior is scripted by directives embedded in user text or, for a
// fresh session, in the task metadata supplied through the real drivers'
// project context:
//   e2e:write=<relpath>:<content>   write a file into the task's worktree
//   e2e:sleep=<ms>                  hold the turn open (Stop / queue tests)
//   e2e:fail=<message>              end the turn with an error event
//   e2e:suggest=<title>             create a suggested task + emit "suggested"
//   e2e:ask=<question>|<opt>|<opt>  park on an AskUserQuestion card until the
//                                   user answers (a Stop dismisses it), then
//                                   keep working — mirrors the Claude hook
// With no directives, the turn appends the prompt to AGENT_NOTES.md — so every
// plain turn still produces a diff to view and merge.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AskQuestion, Project, Task } from "@/lib/types";
import type {
  AgentAuthStatus,
  AgentDriver,
  AgentLoginSession,
  AgentVerifyResult,
  StreamEvent,
} from "../types";
import { createSuggestedTask } from "@/lib/agentTools";
import { waitForAnswer } from "@/lib/asks";
import { MOCK_CAPABILITIES } from "./capabilities";

const MOCK_EMAIL = "e2e@example.com";
const MOCK_PLAN = "Mock";

function loginSuccess(): AgentLoginSession {
  return { status: "success", url: null, email: MOCK_EMAIL, plan: MOCK_PLAN, error: null, log: "mock login ok\n" };
}

/** Abort-aware sleep: resolves early (and quietly) when the turn is stopped. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Resolve a directive's relative path inside the cwd, refusing escapes. */
function safeJoin(cwd: string, rel: string): string | null {
  const abs = path.resolve(cwd, rel);
  return abs === cwd || abs.startsWith(cwd + path.sep) ? abs : null;
}

let currentLogin: AgentLoginSession | null = null;

export const mockDriver: AgentDriver = {
  id: "mock",
  label: "Mock Agent",
  capabilities: MOCK_CAPABILITIES,

  async *runTurn(task: Task, project: Project, userText: string, abort?: AbortController): AsyncGenerator<StreamEvent> {
    const signal = abort?.signal;
    const cwd = task.worktree_path || project.repo_path;
    const sessionId = task.session_id || `mock-${task.id}-g${task.generation}`;
    // Fresh session: the directives can live in the task metadata (which the real
    // drivers deliver through the project context) as well as in the message. The
    // first turn's userText is buildInitialPrompt(), which ALREADY embeds the
    // title + description — appending them again made every directive fire twice
    // (two suggestions, two asks, two writes), so only add parts userText lacks.
    const instructionText = task.session_id
      ? userText
      : [task.title, task.description].filter((p) => p && !userText.includes(p)).concat(userText).join("\n");

    yield { type: "session", sessionId };
    yield { type: "model", model: "mock-1" };

    // Interactive asks come FIRST, before any sleep/work: the turn parks on the
    // user exactly like the Claude driver's PreToolUse hook (same registry,
    // same abort semantics), and once every card is answered the rest of the
    // directives run — so `e2e:ask=… e2e:sleep=3000` means "ask, then keep
    // working for 3s after the answer", which is what the resumed-turn UI
    // (progress dots, spinners) is tested against.
    let askN = 0;
    for (const m of instructionText.matchAll(/e2e:ask=(.+?)(?=\s+e2e:|\n|$)/g)) {
      const [question, ...labels] = m[1].split("|").map((s) => s.trim()).filter(Boolean);
      const id = `mock-ask-${sessionId}-${Date.now().toString(36)}-${++askN}`;
      const questions: AskQuestion[] = [{ question: question || "Which?", header: "Mock", options: (labels.length ? labels : ["A", "B"]).map((label) => ({ label })) }];
      yield { type: "ask", id, questions };
      let answers;
      try {
        answers = await waitForAnswer(task.id, id, questions, signal);
      } catch {
        return; // Stop while parked: the turn ends unanswered, no error event
      }
      yield { type: "ask_answered", id, answers };
    }

    const sleepMs = instructionText.match(/e2e:sleep=(\d+)/)?.[1];
    if (sleepMs) await sleep(Math.min(Number(sleepMs), 120_000), signal);
    if (signal?.aborted) return; // a Stop ends the stream without an error event

    const fail = instructionText.match(/e2e:fail=([^\n]+)/)?.[1];
    if (fail) {
      yield { type: "error", content: fail.trim() };
      return;
    }

    // File writes: every explicit e2e:write, else the default notes append.
    const writes: { rel: string; content: string }[] = [];
    for (const m of instructionText.matchAll(/e2e:write=([^\s:]+):([^\n]+)/g)) {
      writes.push({ rel: m[1], content: m[2].trim() + "\n" });
    }
    if (writes.length === 0) {
      writes.push({ rel: "AGENT_NOTES.md", content: `- ${userText.split("\n")[0].slice(0, 200)}\n` });
    }
    let toolN = 0;
    for (const w of writes) {
      const abs = safeJoin(cwd, w.rel);
      const id = `mock-tool-${++toolN}`;
      yield { type: "tool", id, title: "Write", detail: w.rel, peek: { kind: "count", text: "1 file" } };
      if (!abs) {
        yield { type: "tool_result", id, content: `refused path outside worktree: ${w.rel}`, isError: true };
        continue;
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (w.rel === "AGENT_NOTES.md") fs.appendFileSync(abs, w.content);
      else fs.writeFileSync(abs, w.content);
      yield { type: "tool_result", id, content: `wrote ${w.rel}`, isError: false };
    }

    // Commit the work like a real coding agent would — an uncommitted-only
    // worktree has zero commits ahead of base, which the diff route reads as
    // "already merged". Best-effort: a non-git cwd just skips it.
    try {
      execFileSync("git", ["add", "-A"], { cwd, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", `mock: ${task.title}`], { cwd, stdio: "ignore" });
    } catch {
      // not a repo / nothing to commit — fine
    }

    for (const m of instructionText.matchAll(/e2e:suggest=([^\n]+)/g)) {
      const title = m[1].trim();
      // Same provenance stamp the real drivers write, so the e2e tray exercises
      // the grouped-by-proposer rendering rather than the ungrouped fallback.
      createSuggestedTask(project, { title, description: "Suggested by the mock agent (e2e)." }, { taskId: task.id, generation: task.generation });
      yield { type: "suggested", title };
    }

    yield {
      type: "assistant",
      content: `Mock turn complete. Wrote ${writes.map((w) => `\`${w.rel}\``).join(", ")} in \`${path.basename(cwd)}\`.`,
    };
    yield { type: "usage", usage: { cost_usd: 0, input_tokens: 120, output_tokens: 40, cache_read_tokens: 0, cache_creation_tokens: 0 } };
    yield { type: "done", sessionId };
  },

  // One-shot helpers return canned text so /clear, recap, and "Refresh with AI"
  // are exercisable without a real agent.
  async summarizeTranscript(transcript: string) {
    return { text: `Mock handoff summary (${transcript.length} chars of transcript).` };
  },
  async draftProjectContext(project: Project) {
    return { text: `Mock context draft for ${project.name}.` };
  },
  async summarizeProjectRecap(project: Project) {
    return { text: `Mock recap for ${project.name}: everything is fine.` };
  },

  async authStatus(): Promise<AgentAuthStatus> {
    return { authenticated: true, method: "mock", email: MOCK_EMAIL, plan: MOCK_PLAN, error: null };
  },
  async startLogin(): Promise<AgentLoginSession> {
    currentLogin = loginSuccess();
    return currentLogin;
  },
  getLogin(): AgentLoginSession | null {
    return currentLogin;
  },
  async submitLoginCode(): Promise<AgentLoginSession> {
    currentLogin = loginSuccess();
    return currentLogin;
  },
  cancelLogin(): void {
    currentLogin = null;
  },
  async verify(): Promise<AgentVerifyResult> {
    return { ok: true, output: "mock pong", error: null };
  },
};
