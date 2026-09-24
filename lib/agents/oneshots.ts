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

import { promptScope } from "../promptCapture";
import { getDriver, listDrivers, DEFAULT_AGENT } from "./registry";
import { resolveConnectedAgent } from "./connections";
import { addInternalUsage, getSetting } from "../store";
import { track } from "../analytics";
import type { AgentDriver, OneShotResult } from "./types";
import type { Project, Task, TurnUsage } from "../types";
import { backgroundJobsEnabled } from "../backgroundJobs";

// The one-shot helper names on AgentDriver, all optional.
type OneShotKey = "summarizeTranscript" | "draftProjectContext" | "summarizeProjectRecap";

export interface UtilityAgent {
  /** The agent that will actually run project-scoped one-shots; null when NOTHING is connected. */
  id: string | null;
  /** What the settings asked for — `utility_agent`, else the app default, else the built-in. */
  configured: string;
  /** True when `configured` isn't connected and we fell through to another agent. */
  fallback: boolean;
}

/**
 * Resolve the utility agent WITHOUT constructing a driver, so read-only callers
 * (GET /api/agents, which feeds the Settings "effective utility agent" line) can
 * report the fallback without the no-agent-connected throw that utilityDriver()
 * owes its callers.
 *
 * Connected-first: the `utility_agent` setting wins when that agent is actually
 * connected, then the app default agent, then the built-in default, then ANY
 * connected agent — so a Codex-only instance gets working recaps/context drafts
 * without ever touching the setting.
 */
export function resolveUtilityAgent(): UtilityAgent {
  const preferred = [getSetting("utility_agent"), getSetting("default_agent"), DEFAULT_AGENT];
  const configured = preferred.find((p): p is string => !!p) ?? DEFAULT_AGENT;
  const id = resolveConnectedAgent(preferred);
  return { id, configured, fallback: id !== null && id !== configured };
}

/**
 * The agent that runs project-scoped one-shots and backstops any task whose
 * driver doesn't implement a given helper. When no agent is connected at all we
 * throw an actionable error instead of driving a dead CLI into a cryptic
 * failure — the message is what the UI shows (the refresh job persists it to
 * refresh_error), so it names the fix.
 */
export function utilityDriver(): AgentDriver {
  const { id } = resolveUtilityAgent();
  if (id) return getDriver(id);
  const labels = listDrivers().map((d) => d.label).join(" or ");
  throw new Error(
    `No coding agent is connected. Connect ${labels} in Settings → Agents to enable recaps, context refresh, and session summaries.`
  );
}

// Resolve the DRIVER that will run `key`: the preferred one when it implements
// the helper, else the utility agent as backstop. Returning the driver (not just
// the function) is what lets `run` report which agent actually did the work.
function resolveFor<K extends OneShotKey>(preferred: AgentDriver, key: K): AgentDriver {
  if (preferred[key]) return preferred;
  const util = utilityDriver();
  if (!util[key]) throw new Error(`no agent driver implements ${key}`);
  return util;
}

// Every one-shot funnels through here so analytics records WHICH agent actually
// ran each internal job. Both fallback paths (a Codex-only instance running
// recaps the settings still point at Claude for, and a driver leaning on the
// utility agent for a helper it doesn't implement) are invisible otherwise —
// `fallback: true` is how we see them in the wild.
//
// The helpers are plain functions (they don't close over `this`), so invoking
// the resolved reference directly is safe.
async function run<K extends OneShotKey>(
  job: K,
  requested: string,
  preferred: () => AgentDriver,
  invoke: (impl: NonNullable<AgentDriver[K]>) => Promise<OneShotResult>,
  scope: { project_id?: string; task_id?: string } = {},
  unattended = false,
): Promise<string> {
  if (unattended && !backgroundJobsEnabled()) {
    throw new Error("Background jobs are off in Settings → Background jobs");
  }
  const started = Date.now();
  let agent: string | null = null;
  try {
    const driver = resolveFor(preferred(), job);
    agent = driver.id;
    const raw = await promptScope.run({ projectId: scope.project_id!, taskId: scope.task_id, job },
      () => invoke(driver[job] as NonNullable<AgentDriver[K]>));
    // Keep older third-party/test drivers from breaking at runtime while the
    // TypeScript contract moves them to OneShotResult.
    const result: OneShotResult = typeof raw === "string" ? { text: raw } : raw;
    const ms = Date.now() - started;
    const usage = result.usage;
    addInternalUsage({
      job, agent, requested_agent: requested, fallback: agent !== requested,
      ...scope, ok: true, ms, usage,
    });
    trackUsage(job, agent, requested, true, ms, usage);
    return result.text;
  } catch (e) {
    // agent stays null when resolution itself failed (nothing connected) — that
    // distinction is the whole point of tracking failures too.
    const ms = Date.now() - started;
    const recordedAgent = agent ?? requested;
    addInternalUsage({
      job, agent: recordedAgent, requested_agent: requested,
      fallback: agent !== null && agent !== requested, ...scope, ok: false, ms,
    });
    trackUsage(job, agent, requested, false, ms, undefined, e);
    throw e;
  }
}

function trackUsage(
  job: OneShotKey,
  agent: string | null,
  requested: string,
  ok: boolean,
  ms: number,
  usage?: TurnUsage,
  error?: unknown,
) {
  track("internal_job_ran", {
    job, agent, requested, fallback: agent !== null && agent !== requested, ok, ms,
    cost_usd: usage?.cost_usd ?? 0,
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_read_tokens: usage?.cache_read_tokens ?? 0,
    cache_creation_tokens: usage?.cache_creation_tokens ?? 0,
    ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
  });
}

// The wrappers are async so utilityDriver()'s no-agent-connected throw always
// surfaces as a REJECTED PROMISE, never a synchronous throw — callers uniformly
// handle failures with .catch()/try-await (the refresh job persists it to
// refresh_error, the recap sweep skips the project).

/** /clear handoff note — TASK-scoped (the task's agent, else the utility agent). */
export async function summarizeTranscript(task: Task, transcript: string, project: Project): Promise<string> {
  const own = getDriver(task.agent);
  return run("summarizeTranscript", own.id, () => own, (impl) => impl(transcript, project), {
    project_id: project.id,
    task_id: task.id,
  });
}

/** Project-context draft ("Refresh with AI") — PROJECT-scoped (utility agent). */
export async function draftProjectContext(project: Project, digest: string): Promise<string> {
  return run("draftProjectContext", resolveUtilityAgent().configured, utilityDriver, (impl) => impl(project, digest), {
    project_id: project.id,
  });
}

/** "Where you left off" recap — PROJECT-scoped (utility agent). */
export async function summarizeProjectRecap(
  project: Project,
  digest: string,
  options: { unattended?: boolean } = {},
): Promise<string> {
  return run("summarizeProjectRecap", resolveUtilityAgent().configured, utilityDriver, (impl) => impl(project, digest), {
    project_id: project.id,
  }, options.unattended ?? true);
}
