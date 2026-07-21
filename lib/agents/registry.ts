// The driver registry — the seam's single selector, following the pattern of
// lib/billing/ and lib/control-plane/provisioner/. Every call site resolves
// its driver with `getDriver(task.agent)` (never imports a driver module
// directly), so adding an agent is one driver module + one entry here, with
// no edits to the runner, routes, or recap/refresh jobs.
//
// Unlike those seams the selector isn't an env var: the agent id is data,
// persisted per task (tasks.agent) / per project (projects.default_agent).

// NOTE: importing this registry pulls the agent SDKs (serverExternalPackages →
// async externals under Turbopack) into your module graph. Low-level modules
// that only need capability data (context windows, model lists) must import
// lib/agents/capabilities.ts instead — see the poisoning note there.

import type { AgentDriver } from "./types";
import { claudeDriver } from "./claude/driver";
import { codexDriver } from "./codex/driver";

export { DEFAULT_AGENT } from "./capabilities";
import { DEFAULT_AGENT } from "./capabilities";

// Built lazily (on first resolve, not at module load) so importing this registry
// can't dereference a driver mid-load (drivers import store and other app
// modules; a top-level map literal would crash on an import cycle).
let DRIVERS: Record<string, AgentDriver> | null = null;
function drivers(): Record<string, AgentDriver> {
  if (!DRIVERS) DRIVERS = { [claudeDriver.id]: claudeDriver, [codexDriver.id]: codexDriver };
  return DRIVERS;
}

/**
 * Resolve a driver by id. Unknown / null / empty ids fall back to the Claude
 * driver rather than throwing — a task row can only carry a bad agent id via
 * hand-edited data, and a broken row should still run rather than brick the
 * task (mirrors permission_mode's forgiving resolution).
 */
export function getDriver(id: string | null | undefined): AgentDriver {
  const d = drivers();
  return (id && d[id]) || d[DEFAULT_AGENT];
}

/**
 * Strict lookup for the auth routes: returns null for an unknown id instead of
 * falling back to Claude. `getDriver` is forgiving because a bad tasks.agent row
 * should still run *something*; the /api/agents/[id]/* connect routes, by
 * contrast, must 404 rather than silently drive the wrong agent's login.
 */
export function getDriverStrict(id: string): AgentDriver | null {
  return drivers()[id] ?? null;
}

/** Every registered driver, for the client's agent/model pickers (GET /api/agents). */
export function listDrivers(): AgentDriver[] {
  return Object.values(drivers());
}
