import { beforeEach, describe, expect, it } from "vitest";
import { createProject, createTask, setSetting } from "../lib/store";
import { suggestionPolicy } from "../lib/suggestionPolicy";
import { buildProjectContext } from "../lib/agents/shared";
import { SUGGEST_TASK } from "../lib/agentToolDefs.mjs";
import { GET as getSettings, PATCH as patchSettings } from "../app/api/settings/route";

// The Suggested tray is only trustworthy if everything in it is something the
// user wanted. Enforcement is prompt-based (the server can't see a confirmation
// the user gave in prose), so the prompt IS the contract — these tests pin the
// wording the agent reads in both policies.

function patch(body: Record<string, string | null>) {
  return patchSettings(new Request("http://127.0.0.1:3000/api/settings", { method: "PATCH", body: JSON.stringify(body) }));
}

describe("suggestion policy", () => {
  beforeEach(() => setSetting("suggestion_policy", null));

  it("defaults to ask_first, and only the exact string 'auto' opts out", () => {
    expect(suggestionPolicy()).toBe("ask_first");
    setSetting("suggestion_policy", "auto");
    expect(suggestionPolicy()).toBe("auto");
    setSetting("suggestion_policy", "nonsense");
    expect(suggestionPolicy()).toBe("ask_first");
  });

  it("tells the agent to list follow-ups and ask before filing them", () => {
    const project = createProject({ name: "Tray" });
    const task = createTask({ project_id: project.id, title: "Do the thing", agent: "claude" });
    const ctx = buildProjectContext(project, task);

    expect(ctx).toContain("suggest_task");
    // Planning requests still file tasks directly — that's the whole point of the tool.
    expect(ctx).toContain("plan, break down, scope, or roadmap");
    expect(ctx).toContain("use `suggest_task` freely");
    // Everything else is confirm-first, via the driver's own interactive ask.
    expect(ctx).toContain("ASK FIRST");
    expect(ctx).toContain("only after they confirm");
    expect(ctx).toContain("the AskUserQuestion tool");
    // The old always-proactive instruction must be gone.
    expect(ctx).not.toContain("Proactively");
  });

  it("names the portable ask_user tool for non-Claude drivers", () => {
    const project = createProject({ name: "Tray codex" });
    const task = createTask({ project_id: project.id, title: "Codex task", agent: "codex" });
    const ctx = buildProjectContext(project, task);
    expect(ctx).toContain("the `ask_user` tool");
    expect(ctx).not.toContain("AskUserQuestion");
  });

  it("restores the proactive wording under `auto`, and says it overrides the tool description", () => {
    setSetting("suggestion_policy", "auto");
    const project = createProject({ name: "Tray auto" });
    const task = createTask({ project_id: project.id, title: "Auto task", agent: "claude" });
    const ctx = buildProjectContext(project, task);

    expect(ctx).toContain("Proactively");
    expect(ctx).toContain("no need to ask first");
    expect(ctx).toContain("overrides the ask-first");
    expect(ctx).not.toContain("ASK FIRST");
  });

  it("mirrors the ask-first rule in the tool description both drivers build from", () => {
    expect(SUGGEST_TASK.description).toContain("did NOT ask for");
    expect(SUGGEST_TASK.description).toContain("ask the user to confirm first");
    expect(SUGGEST_TASK.description).toContain("AskUserQuestion");
    expect(SUGGEST_TASK.description).toContain("`ask_user`");
  });

  it("is settable through the settings API and defaults back when cleared", async () => {
    expect(await (await patch({ suggestion_policy: "auto" })).json()).toMatchObject({ suggestion_policy: "auto" });
    expect(suggestionPolicy()).toBe("auto");

    await patch({ suggestion_policy: null });
    expect(await (await getSettings()).json()).not.toHaveProperty("suggestion_policy");
    expect(suggestionPolicy()).toBe("ask_first");
  });
});
