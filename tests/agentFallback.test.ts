import { describe, expect, it, beforeEach } from "vitest";

// Connected-first agent resolution: the utility agent for internal one-shots
// (lib/agents/oneshots.ts), the connection record with its legacy-Claude
// fallback (lib/agents/connections.ts), the client's new-task default
// (app/orchestrator/agents.ts), and the onboarding completion adoption that
// makes a Codex-only first run work end to end (lib/onboarding.ts).

import { setSetting, getSetting, createProject, createTask, getTask, updateTask } from "../lib/store";
import { getDb } from "../lib/db";
import { setAgentConnection, isAgentConnected, firstConnectedAgent, resolveConnectedAgent } from "../lib/agents/connections";
import { utilityDriver } from "../lib/agents/oneshots";
import { completeOnboarding } from "../lib/onboarding";
import { defaultAgentFor } from "../app/orchestrator/agents";
import type { AgentsBundle } from "../app/orchestrator/types";

// Settings persist across tests (one shared DB per suite run) — reset every key
// the resolvers read so each test states its own world.
function resetSettings() {
  for (const key of [
    "utility_agent",
    "default_agent",
    "agent_conn_claude",
    "agent_conn_codex",
    "onboarding_method",
    "onboarding_account",
    "onboarding_complete",
  ]) {
    setSetting(key, null);
  }
}

const connect = (id: string) => setAgentConnection(id, { method: "subscription", email: null, plan: null });

describe("connection record", () => {
  beforeEach(resetSettings);

  it("treats a pre-seam onboarding record as a live Claude connection", () => {
    expect(isAgentConnected("claude")).toBe(false);
    setSetting("onboarding_method", "subscription");
    setSetting("onboarding_account", "a@b.c|Max");
    expect(isAgentConnected("claude")).toBe(true);
    // The legacy fallback is Claude-only — other agents need a real record.
    expect(isAgentConnected("codex")).toBe(false);
  });

  it("resolves the first connected agent from an ordered preference list", () => {
    connect("codex");
    // Preferred but unconnected (claude) is skipped; unknown ids are skipped.
    expect(resolveConnectedAgent(["claude", "codex"])).toBe("codex");
    expect(resolveConnectedAgent(["not-an-agent"])).toBe("codex");
    expect(firstConnectedAgent()).toBe("codex");
  });
});

describe("utilityDriver (connected-first)", () => {
  beforeEach(resetSettings);

  it("throws an actionable error when no agent is connected", () => {
    expect(() => utilityDriver()).toThrow(/No coding agent is connected/);
  });

  it("falls to the only connected agent on a Codex-only instance", () => {
    connect("codex");
    expect(utilityDriver().id).toBe("codex");
  });

  it("prefers the built-in default when it is connected", () => {
    connect("claude");
    connect("codex");
    expect(utilityDriver().id).toBe("claude");
  });

  it("honors an explicit utility_agent that is connected", () => {
    connect("claude");
    connect("codex");
    setSetting("utility_agent", "codex");
    expect(utilityDriver().id).toBe("codex");
  });

  it("ignores an explicit utility_agent that is NOT connected", () => {
    connect("claude");
    setSetting("utility_agent", "codex");
    expect(utilityDriver().id).toBe("claude");
  });

  it("surfaces the no-agent error as a rejection from the async one-shots", async () => {
    const { summarizeProjectRecap } = await import("../lib/agents/oneshots");
    const project = createProject({ name: "NoAgents" });
    await expect(summarizeProjectRecap(project, "digest")).rejects.toThrow(/No coding agent is connected/);
  });
});

describe("defaultAgentFor (client, connected-first)", () => {
  const bundle = (authed: Record<string, boolean>, def = "claude"): AgentsBundle => ({
    default: def,
    agents: Object.entries(authed).map(([id, authenticated]) => ({
      id,
      label: id,
      capabilities: {
        models: [],
        reasoningOptions: [],
        permissionModes: [],
        supportsAsks: true,
        supportsMcpTools: true,
        reportsCostUsd: true,
        costIsEstimated: false,
        supportsResume: true,
      },
      authenticated,
    })),
  });

  it("keeps the project/app default when it is connected", () => {
    expect(defaultAgentFor(bundle({ claude: true, codex: true }), null)).toBe("claude");
    expect(defaultAgentFor(bundle({ claude: true, codex: true }), "codex")).toBe("codex");
  });

  it("falls to the first connected agent when the default is not", () => {
    expect(defaultAgentFor(bundle({ claude: false, codex: true }), null)).toBe("codex");
    expect(defaultAgentFor(bundle({ claude: true, codex: false }), "codex")).toBe("claude");
  });

  it("falls back to existence when nothing is connected", () => {
    expect(defaultAgentFor(bundle({ claude: false, codex: false }), null)).toBe("claude");
  });
});

describe("completeOnboarding adopts the connected agent", () => {
  beforeEach(resetSettings);

  it("retargets the app default and the seeded tutorial on a Codex-only run", () => {
    const project = createProject({ name: "WelcomeSeed" });
    getDb().prepare("UPDATE projects SET seeded = 1, default_agent = 'claude' WHERE id = ?").run(project.id);
    const fresh = createTask({ project_id: project.id, title: "Tutorial", description: "" });
    const started = createTask({ project_id: project.id, title: "Started", description: "" });
    updateTask(started.id, { started: 1 });
    getDb().prepare("UPDATE tasks SET agent = 'claude' WHERE id IN (?, ?)").run(fresh.id, started.id);

    connect("codex"); // claude never connected
    completeOnboarding();

    expect(getSetting("default_agent")).toBe("codex");
    const proj = getDb().prepare("SELECT default_agent FROM projects WHERE id = ?").get(project.id) as { default_agent: string };
    expect(proj.default_agent).toBe("codex");
    expect(getTask(fresh.id)?.agent).toBe("codex");
    // A task that already ran keeps its agent — a session lineage can't switch CLIs.
    expect(getTask(started.id)?.agent).toBe("claude");
  });

  it("changes nothing when the default agent is connected", () => {
    connect("claude");
    connect("codex");
    completeOnboarding();
    expect(getSetting("default_agent")).toBeNull();
  });

  it("changes nothing when no agent is connected (skip setup)", () => {
    completeOnboarding();
    expect(getSetting("default_agent")).toBeNull();
  });
});
