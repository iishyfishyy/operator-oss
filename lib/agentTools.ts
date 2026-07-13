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

import type { Project, Task, ServiceInfo, Priority } from "./types";
import { createTask, setTaskDeps } from "./store";
import { exposeService } from "./services";

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
 * Create a suggested task in `project` and (optionally) set its dependencies.
 * Returns the created task plus the human-readable confirmation text both the
 * MCP server and the HTTP endpoint hand back to the agent verbatim. Bad deps
 * degrade to a note rather than throwing (setTaskDeps drops foreign ids and
 * rejects cycles).
 */
export function createSuggestedTask(project: Project, input: SuggestTaskInput): { task: Task; text: string } {
  const task = createTask({
    project_id: project.id,
    title: input.title,
    description: input.description,
    priority: input.priority ?? "med",
    suggested: true,
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
