// Routing for the "internal" one-shot jobs — the turns that run OUTSIDE the
// main chat: /clear handoff summaries, project recaps, and context drafts.
// Every such job resolves its driver here instead of calling getDriver()
// directly, so the two policies below live in one place.
//
// Two policies:
//   - TASK-scoped one-shots follow the TASK's own agent, so the work (and the
//     token cost) lands on the login the task runs on — a Codex task's /clear
//     handoff note is written by Codex, counted against the Codex login.
//     summarizeTranscript is the only task-scoped helper.
//   - PROJECT-scoped one-shots (context draft, recap) aren't tied to any single
//     task's agent, so they run on the configured UTILITY agent (the
//     `utility_agent` app setting, default "claude").
//
// Either way, if the chosen driver doesn't implement a given helper, we fall
// back to the utility agent's implementation — a new driver can ship runTurn()
// alone and still get working /clear summaries, recaps, and context drafts.

import { getDriver, DEFAULT_AGENT } from "./registry";
import { getSetting } from "../store";
import type { AgentDriver } from "./types";
import type { Project, Task } from "../types";

// The one-shot helper names on AgentDriver, all optional.
type OneShotKey = "summarizeTranscript" | "draftProjectContext" | "summarizeProjectRecap";

/**
 * The agent that runs project-scoped one-shots and backstops any task whose
 * driver doesn't implement a given helper. Configured via the `utility_agent`
 * setting; falls back to the built-in default agent (Claude), which implements
 * every helper, so the backstop is always resolvable.
 */
export function utilityDriver(): AgentDriver {
  return getDriver(getSetting("utility_agent") || DEFAULT_AGENT);
}

// Resolve a helper off `preferred`, falling back to the utility agent's
// implementation when the preferred driver doesn't provide it. The helpers are
// plain functions (they don't close over `this`), so calling the resolved
// reference directly is safe.
function resolve<K extends OneShotKey>(preferred: AgentDriver, key: K): NonNullable<AgentDriver[K]> {
  const impl = preferred[key] ?? utilityDriver()[key];
  if (!impl) throw new Error(`no agent driver implements ${key}`);
  return impl as NonNullable<AgentDriver[K]>;
}

/** /clear handoff note — TASK-scoped (the task's agent, else the utility agent). */
export function summarizeTranscript(task: Task, transcript: string, project: Project): Promise<string> {
  return resolve(getDriver(task.agent), "summarizeTranscript")(transcript, project);
}

/** Project-context draft ("Refresh with AI") — PROJECT-scoped (utility agent). */
export function draftProjectContext(project: Project, digest: string): Promise<string> {
  return resolve(utilityDriver(), "draftProjectContext")(project, digest);
}

/** "Where you left off" recap — PROJECT-scoped (utility agent). */
export function summarizeProjectRecap(project: Project, digest: string): Promise<string> {
  return resolve(utilityDriver(), "summarizeProjectRecap")(project, digest);
}
