// Shared implementations of the orchestrator's agent-facing tools
// (suggest_task / expose_service). One home for the LOGIC so both callers agree:
//   - the Claude driver's in-process SDK MCP server (lib/agents/claude/driver.ts)
//   - the internal HTTP endpoints the stdio bridge proxies to
//     (app/api/internal/agent-tools/*), which serve Codex and any future CLI
//
// The tool *definitions* (names/descriptions/params) live in lib/agentToolDefs.mjs;
// this file is the behaviour behind them. Both are deliberately split so the
// plain-Node bridge (scripts/orch-mcp.mjs) can import the defs without pulling in
// the TS/SQLite graph.

import { nanoid } from "nanoid";
import type { Project, Task, ServiceInfo, Priority, AskQuestion, ToolData } from "./types";
import { createTask, setTaskDeps, addMessage, updateMessage, updateTask, getProject, getTask } from "./store";
import { exposeService } from "./services";
import { publish } from "./events";
import { waitForAnswer, settleAsk } from "./asks";
import { turnSignal } from "./abort";
import { formatAnswers } from "./agents/shared";
import { resolveConnectedAgent } from "./agents/connections";

/**
 * Resolve `blocked_by` refs against a per-session title→id map: an id passes
 * through; a title of a task suggested earlier this session maps to its id;
 * anything else is left as-is (setTaskDeps drops unknown/foreign ids safely).
 * Callers own the map because it is inherently session-scoped — the Claude
 * driver keeps one per turn, the stdio bridge keeps one per (per-turn) process.
 */
export function resolveTitleRefs(refs: string[] | undefined, createdByTitle: Map<string, string>): string[] {
  return (refs ?? []).map((ref) => createdByTitle.get(ref) ?? ref);
}

export interface SuggestTaskInput {
  title: string;
  description: string;
  priority?: Priority;
  /** Already resolved to task ids (see resolveTitleRefs) — id passes through to setTaskDeps. */
  blocked_by?: string[];
}

/**
 * Which running session proposed a suggestion. Both callers know it — the Claude
 * driver's MCP server closes over the task, the stdio bridge is spawned per turn
 * and posts its task id — so every new tray entry can be grouped under the task
 * (and the /clear generation) that thought of it.
 */
export interface SuggestSource {
  taskId: string;
  generation: number;
}

/**
 * Create a suggested task in `project` and (optionally) set its dependencies.
 * Returns the created task plus the human-readable confirmation text both the
 * MCP server and the HTTP endpoint hand back to the agent verbatim. Bad deps
 * degrade to a note rather than throwing (setTaskDeps drops foreign ids and
 * rejects cycles). A null task means the project vanished and nothing was made.
 */
export function createSuggestedTask(project: Project, input: SuggestTaskInput, source?: SuggestSource): { task: Task | null; text: string } {
  // `project` can be the snapshot captured at turn START (the Claude driver's
  // MCP server closes over it) — the row may have been deleted while the turn
  // ran, and inserting its id would hit tasks' project_id FOREIGN KEY. Re-read
  // at insert time and hand the agent a refusal instead of throwing.
  if (!getProject(project.id)) {
    return { task: null, text: `Could not add "${input.title}": the project no longer exists.` };
  }
  const task = createTask({
    project_id: project.id,
    title: input.title,
    description: input.description,
    priority: input.priority ?? "med",
    suggested: true,
    // Connected-first, matching the New-task dialog (defaultAgentFor). A task's
    // agent is fixed for its whole life, so inheriting an unconnected project
    // default would mint tasks that can never run — the exact way a Codex-only
    // instance would silently accumulate dead Claude tasks in the tray. Null
    // (nothing connected) leaves createTask's own default in place.
    agent: resolveConnectedAgent([project.default_agent]) ?? undefined,
    // Same mid-turn-deletion hazard as the project above: suggested_by_task_id
    // is a FOREIGN KEY, so a proposer deleted while its turn ran would make the
    // INSERT throw. Drop the provenance instead — the suggestion still lands,
    // it just groups under "Other".
    ...(source && getTask(source.taskId)
      ? { suggested_by_task_id: source.taskId, suggested_by_generation: source.generation }
      : {}),
  });
  let depNote = "";
  if (input.blocked_by?.length) {
    try {
      setTaskDeps(task.id, input.blocked_by);
      depNote = ` Blocked by ${input.blocked_by.length} task(s).`;
    } catch (e) {
      depNote = ` (Could not set dependencies: ${(e as Error).message}.)`;
    }
  }
  return {
    task,
    text: `Suggested task "${input.title}" added to the project tray (id: ${task.id}).${depNote}`,
  };
}

/**
 * Register a service the agent just started (the expose_service tool). Records
 * the port/url so it shows in the Services panel and returns the URL to hand the
 * user, plus the confirmation text. We don't own the process — this entry is
 * informational (see lib/services.ts exposeService).
 */
/**
 * Surface an ask_user question card and wait for the answer — the bridge-served
 * counterpart of the Claude driver's AskUserQuestion hook. Unlike suggest_task /
 * expose_service this is asynchronous by nature: we persist + publish the ask
 * card here (the same tool-row shape the runner writes, so the UI and the
 * /answer route treat it identically), then park a DETACHED waiter on
 * lib/asks.ts. The bridge polls takeAskOutcome() via the wait endpoint — no
 * long-held HTTP request, per the house rule. The waiter is tied to the live
 * turn's abort signal, so a Stop settles it as a dismissal.
 */
export function startAskUser(task: Task, questions: AskQuestion[]): { askId: string } {
  const askId = `ask-${nanoid()}`;
  const data: ToolData = { title: "Question for you", ask: { id: askId, questions } };
  const m = addMessage(task.id, task.generation, "tool", JSON.stringify(data));
  // The turn is live but parked on the user — same flag the runner sets for
  // Claude asks, driving the "Needs your input" badges. Cleared on answer below;
  // the runner's turn-end finally re-settles it either way.
  updateTask(task.id, { awaiting_input: 1 });
  publish(task.id, { type: "ask", id: askId, questions, msgId: m.id, generation: task.generation, ts: m.created_at });

  void waitForAnswer(task.id, askId, questions, turnSignal(task.id))
    .then((answers) => {
      data.ask = { id: askId, questions, answers };
      updateMessage(m.id, JSON.stringify(data));
      updateTask(task.id, { awaiting_input: 0 });
      publish(task.id, { type: "ask_answered", id: askId, answers, msgId: m.id, generation: task.generation });
      settleAsk(task.id, askId, formatAnswers(questions, answers));
    })
    .catch(() => {
      // Turn torn down (Stop) before an answer arrived. The card stays in the
      // transcript unanswered — answering it later falls back to the /answer
      // route's resolved:false path (a normal reply into a fresh turn).
      settleAsk(task.id, askId, "The user dismissed the question without answering.");
    });

  return { askId };
}

export function registerExposedService(project: Project, name: string, port: number): { info: ServiceInfo; url: string; text: string } {
  const info = exposeService(project, name.trim() || "dev", port);
  const url = info.url ?? `http://localhost:${port}`;
  const text =
    `Registered "${info.name}" on port ${port}. It's reachable at ${url} — ` +
    `give the user this exact URL. It now shows in the project's Services panel` +
    (info.visibility === "private"
      ? ` (visibility: private — only the signed-in owner can open it; they can share it from the panel).`
      : ` (visibility: ${info.visibility}).`);
  return { info, url, text };
}
