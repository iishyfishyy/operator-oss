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

import { getDriver, listDrivers, DEFAULT_AGENT } from "./registry";
import { resolveConnectedAgent } from "./connections";
import { getSetting } from "../store";
import type { AgentDriver } from "./types";
import type { Project, Task } from "../types";

// The one-shot helper names on AgentDriver, all optional.
type OneShotKey = "summarizeTranscript" | "draftProjectContext" | "summarizeProjectRecap";

/**
 * The agent that runs project-scoped one-shots and backstops any task whose
 * driver doesn't implement a given helper. Resolution is connected-first: the
 * `utility_agent` setting wins when that agent is actually connected, then the
 * app default agent, then the built-in default, then ANY connected agent — so a
 * Codex-only instance gets working recaps/context drafts without ever touching
 * the setting. When no agent is connected at all we throw an actionable error
 * instead of driving a dead CLI into a cryptic failure.
 */
export function utilityDriver(): AgentDriver {
  const id = resolveConnectedAgent([getSetting("utility_agent"), getSetting("default_agent"), DEFAULT_AGENT]);
  if (id) return getDriver(id);
  const labels = listDrivers().map((d) => d.label).join(" or ");
  throw new Error(
    `No coding agent is connected. Connect ${labels} in Settings → Agents to enable recaps, context refresh, and session summaries.`
  );
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

// The wrappers are async so utilityDriver()'s no-agent-connected throw always
// surfaces as a REJECTED PROMISE, never a synchronous throw — callers uniformly
// handle failures with .catch()/try-await (the refresh job persists it to
// refresh_error, the recap sweep skips the project).

/** /clear handoff note — TASK-scoped (the task's agent, else the utility agent). */
export async function summarizeTranscript(task: Task, transcript: string, project: Project): Promise<string> {
  return resolve(getDriver(task.agent), "summarizeTranscript")(transcript, project);
}

/** Project-context draft ("Refresh with AI") — PROJECT-scoped (utility agent). */
export async function draftProjectContext(project: Project, digest: string): Promise<string> {
  return resolve(utilityDriver(), "draftProjectContext")(project, digest);
}

/** "Where you left off" recap — PROJECT-scoped (utility agent). */
export async function summarizeProjectRecap(project: Project, digest: string): Promise<string> {
  return resolve(utilityDriver(), "summarizeProjectRecap")(project, digest);
}
