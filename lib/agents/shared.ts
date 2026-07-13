// Agent-agnostic building blocks shared by every driver: the project-context
// prompt, the conflict-resolution prompt, and the normalizers that turn a raw
// tool call/result into the UI's title/detail/peek shape. Nothing in here
// knows which agent is running — drivers reuse these to emit the normalized
// StreamEvent contract (see lib/agents/types.ts).

import type { Project, Task, AskQuestion, AskAnswers, ToolPeek, DiffLine } from "../types";
import { listSummaries } from "../store";

/**
 * Build the context string that is prepended to every task's session via the
 * agent's system prompt. This is the "write project context once" feature:
 * project description + conventions + the task framing + any prior-session
 * summaries from earlier generations of this task.
 */
export function buildProjectContext(project: Project, task: Task): string {
  const summaries = listSummaries(task.id);
  const ctx = project.context || [project.building, project.conventions].filter(Boolean).join("\n");
  const lines: string[] = [];
  lines.push(`You are working inside the project "${project.name}".`);
  if (ctx) lines.push(`\nWhat we're building (project context):\n${ctx}`);
  if (project.branch) lines.push(`\nGit branch: ${project.branch}`);
  lines.push(`\n---\nThe current task is: "${task.title}"`);
  if (task.description) lines.push(`Task details: ${task.description}`);

  if (summaries.length > 0) {
    lines.push(`\n--- Carried context from previous sessions of this task ---`);
    for (const s of summaries) {
      lines.push(`\n[Session ${s.generation} summary]\n${s.summary}`);
    }
    lines.push(`\nContinue this task from where the previous session left off.`);
  }

  lines.push(
    `\n---\nYou have an "orchestrator" MCP tool \`suggest_task\` that creates a task in ` +
      `THIS project. New tasks land in the user's "Suggested" tray for them to review and ` +
      `start later as their own Claude session. Use it two ways:\n` +
      `1. On request — when the user asks you to plan, break down, scope, or roadmap work, ` +
      `call \`suggest_task\` once per task you propose (set a sensible priority for each). ` +
      `Create as many as the plan needs.\n` +
      `2. Proactively — if you notice follow-up work that is out of scope for the CURRENT ` +
      `task, don't do it now; propose it with \`suggest_task\` instead.`
  );
  lines.push(
    `\nYou also have an \`expose_service\` MCP tool. When you start a long-running server ` +
      `(dev server, API, preview, Storybook, etc.) and it's listening, call ` +
      `\`expose_service(name, port)\` to register it — it appears in the project's Services ` +
      `panel and the tool RETURNS the URL the user can open (on a hosted instance that is a ` +
      `real public hostname like <name>--<instance-host>; reply with that exact URL so ` +
      `the user can verify your work live). Names are slugified to lowercase [a-z0-9-]. Prefer ` +
      `the PORT environment variable the orchestrator injected ` +
      `(${project.port ? `PORT=${project.port}` : "set per project"}) so the address is stable. ` +
      `Because the URL is proxied under that hostname, allow it in dev-server host checks when ` +
      `you scaffold or configure an app: Vite → \`server.allowedHosts: [process.env.ORCH_PUBLIC_HOST]\` ` +
      `(or \`true\`), Next dev → \`allowedDevOrigins: [process.env.ORCH_PUBLIC_HOST]\` in next.config, ` +
      `CRA/webpack-dev-server is pre-cleared via env. ORCH_PUBLIC_HOST is injected into services ` +
      `the orchestrator starts.`
  );
  return lines.join("\n");
}

/**
 * Prompt for an AI conflict-resolution turn. The task's base branch has been
 * trial-merged into its work branch (in the isolated worktree), leaving conflict
 * markers in the listed files. The agent resolves them in place. Completion
 * (commit + land into base) is handled by the app on the user's Accept, so we
 * tell it not to commit — though the flow is robust if it does anyway.
 */
export function buildConflictPrompt(baseBranch: string, conflicts: string[]): string {
  const files = conflicts.map((f) => `  - ${f}`).join("\n");
  return [
    `I merged \`${baseBranch}\` into this branch and hit merge conflicts. Please resolve every conflict.`,
    ``,
    `Conflicted files:`,
    files,
    ``,
    `For each file, remove all conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`) and produce a`,
    `correct merged result that preserves the intent of BOTH sides — don't blindly pick one side.`,
    `Read the surrounding code and, where the two changes are independent, keep both. Run \`git diff\``,
    `or inspect the files as needed to understand each side.`,
    ``,
    `Do NOT run \`git commit\`, \`git merge --continue\`, or \`git add\` — just edit the files to a clean,`,
    `marker-free state. I'll review your resolution and land the merge myself.`,
  ].join("\n");
}

export function clip(s: unknown, n = 4000): string {
  const str = typeof s === "string" ? s : JSON.stringify(s, null, 2);
  return str.length > n ? str.slice(0, n) + `\n… (${str.length - n} more chars)` : str;
}

// How a tool's eventual result should be summarized into a peek. The result
// content only arrives later (a separate tool_result event), so describeToolUse
// records the *kind* and summarizeResult turns the raw output into the peek.
export type ResultKind = "read" | "output" | "grep" | "glob";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// Line diff for an Edit's old/new strings. Not full LCS: edits are localized,
// so trimming the common prefix/suffix and keeping a few unchanged lines of
// context on each side reads like a real diff hunk without the machinery.
const DIFF_CTX = 3;
export function diffLines(oldS: string, newS: string): DiffLine[] {
  const a = oldS ? oldS.split("\n") : [];
  const b = newS ? newS.split("\n") : [];
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return [
    ...a.slice(Math.max(0, pre - DIFF_CTX), pre).map((text) => ({ sign: " " as const, text })),
    ...a.slice(pre, a.length - suf).map((text) => ({ sign: "-" as const, text })),
    ...b.slice(pre, b.length - suf).map((text) => ({ sign: "+" as const, text })),
    ...a.slice(a.length - suf, a.length - suf + DIFF_CTX).map((text) => ({ sign: " " as const, text })),
  ];
}

// Cap the stored full diff so a giant Edit doesn't bloat the DB row / SSE event.
const DIFF_MAX = 400;
function capDiff(diff: DiffLine[]): DiffLine[] {
  return diff.length <= DIFF_MAX ? diff : [...diff.slice(0, DIFF_MAX), { sign: " ", text: `… (${diff.length - DIFF_MAX} more lines)` }];
}

// The always-visible peek: exact +/− counts over a capped slice of the hunk.
function diffPeek(diff: DiffLine[], label?: string): ToolPeek {
  const added = diff.filter((l) => l.sign === "+").length;
  const removed = diff.filter((l) => l.sign === "-").length;
  const MAX = 14;
  return { kind: "diff", added, removed, label, lines: diff.slice(0, MAX), truncated: Math.max(0, diff.length - MAX) };
}

// Turn a tool's raw (pre-clip) result into its peek, by kind.
export function summarizeResult(kind: ResultKind, raw: string): ToolPeek {
  const lines = raw ? raw.split("\n") : [];
  const hits = lines.filter((l) => l.trim()).length;
  switch (kind) {
    case "read":
      return { kind: "count", text: `Read ${plural(lines.length, "line")}` };
    case "grep":
      return { kind: "count", text: `Found ${plural(hits, "match")}` };
    case "glob":
      return { kind: "count", text: `Found ${plural(hits, "file")}` };
    case "output": {
      if (!raw.trim()) return { kind: "count", text: "No output" };
      const MAX = 6;
      return { kind: "lines", lines: lines.slice(0, MAX), truncated: Math.max(0, lines.length - MAX) };
    }
  }
}

// Returns a one-line title, an expandable detail of the tool input, an optional
// always-visible peek, and (for result-derived peeks) the kind to summarize the
// eventual output with. Mirrors what Claude Code reveals per tool; the names
// are the common coding-agent tool vocabulary, and the default arm renders any
// unknown tool generically — so other drivers can reuse this as-is.
export function describeToolUse(
  name: string,
  input: Record<string, unknown>
): { title: string; detail: string; peek?: ToolPeek; diff?: DiffLine[]; resultKind?: ResultKind } {
  const file = (input?.file_path || input?.path || input?.notebook_path) as string | undefined;
  const base = file ? file.split("/").slice(-1)[0] : undefined;
  switch (name) {
    case "Write": {
      const content = typeof input?.content === "string" ? input.content : "";
      const diff = diffLines("", content);
      return {
        title: `✎ Write ${base ?? "file"}`,
        detail: file ?? "",
        diff: capDiff(diff),
        peek: diffPeek(diff, `Wrote ${plural(diff.length, "line")}${base ? ` to ${base}` : ""}`),
      };
    }
    case "Edit":
    case "NotebookEdit": {
      const diff = diffLines(
        typeof input?.old_string === "string" ? input.old_string : "",
        typeof input?.new_string === "string" ? input.new_string : ""
      );
      return { title: `✎ Edit ${base ?? "file"}`, detail: file ?? "", diff: capDiff(diff), peek: diffPeek(diff) };
    }
    case "Read":
      return { title: `📖 Read ${base ?? "file"}`, detail: file ?? "", resultKind: "read" };
    case "Bash":
      return { title: `❯ ${String(input?.command ?? "").split("\n")[0].slice(0, 70)}`, detail: clip(input?.command), resultKind: "output" };
    case "Grep":
      return { title: `🔎 Grep ${String(input?.pattern ?? "")}`, detail: clip(input), resultKind: "grep" };
    case "Glob":
      return { title: `🔎 Glob ${String(input?.pattern ?? "")}`, detail: String(input?.pattern ?? ""), resultKind: "glob" };
    case "TodoWrite": {
      const todos = Array.isArray(input?.todos) ? (input.todos as Record<string, unknown>[]) : [];
      const items = todos.map((t) => ({ text: String(t?.content ?? t?.text ?? ""), status: String(t?.status ?? "pending") }));
      return { title: `☑ Updated todos`, detail: clip(input?.todos), peek: { kind: "todos", items } };
    }
    case "Task":
      return { title: `🤖 Subagent: ${String(input?.description ?? "task")}`, detail: clip(input?.prompt) };
    default:
      if (name.includes("suggest_task")) return { title: `✦ Suggested a task`, detail: clip(input) };
      if (name.includes("expose_service")) return { title: `🔌 Exposed ${String(input?.name ?? "service")} :${String(input?.port ?? "")}`, detail: clip(input) };
      return { title: `⚙ ${name}`, detail: clip(input) };
  }
}

// Format the user's ask answers into the text fed back to the agent as the
// tool result (for Claude, delivered via the PreToolUse hook's deny reason).
export function formatAnswers(questions: AskQuestion[], answers: AskAnswers): string {
  const lines = questions.map((q, i) => {
    const picked = (answers[i] ?? []).filter((s) => s && s.trim());
    return `- ${q.header || q.question}: ${picked.length ? picked.join(", ") : "(no selection)"}`;
  });
  return `The user answered your question${questions.length > 1 ? "s" : ""}:\n${lines.join("\n")}\n\nProceed based on these choices.`;
}

// Minimal push/pull async queue. A driver's native message pump and any
// interactive hooks (asks) both push events; runTurn yields them in order
// until the queue closes. A queue is needed because hooks fire *inside* the
// native iteration (they park awaiting the user), so they can't yield from
// runTurn directly — they push here.
export function makeQueue<T>() {
  const items: T[] = [];
  let waiting: ((r: IteratorResult<T>) => void) | null = null;
  let closed = false;
  return {
    push(item: T) {
      if (closed) return;
      if (waiting) {
        const w = waiting;
        waiting = null;
        w({ value: item, done: false });
      } else items.push(item);
    },
    close() {
      closed = true;
      if (waiting) {
        const w = waiting;
        waiting = null;
        w({ value: undefined as never, done: true });
      }
    },
    async *drain(): AsyncGenerator<T> {
      while (true) {
        if (items.length) {
          yield items.shift()!;
          continue;
        }
        if (closed) return;
        const r = await new Promise<IteratorResult<T>>((res) => {
          waiting = res;
        });
        if (r.done) return;
        yield r.value;
      }
    },
  };
}

// Flatten a tool_result's content (string | block list | anything) to text.
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : typeof b === "string" ? b : "")).join("");
  }
  return content == null ? "" : JSON.stringify(content);
}
