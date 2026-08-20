import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";

// Same seam as tests/promptTooLong.test.ts: the Claude driver module is mocked so
// the runner's real error/queue/flag handling runs without the SDK (or a real
// login) anywhere near it. The registry maps "claude" to this module, so
// getDriver(task.agent) resolves the mock.
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Claude Code",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown) =>
      runTurnMock(task, project, userText, ac),
  },
}));

import { createProject, createTask, getTask, listMessages, listPendingMessages, addPendingMessage } from "@/lib/store";
import { startTurn } from "@/lib/runner";
import { subscribe } from "@/lib/events";
import { AUTH_EXPIRED_NOTICE, isAuthFailure } from "@/lib/authFailure";
import { getAgentAuthBroken, clearAgentAuthBroken, markAgentAuthBroken } from "@/lib/agents/connections";
import type { TaskStreamEvent } from "@/lib/types";

const OAUTH_DEAD = "Failed to authenticate: OAuth session expired and could not be refreshed";

// Resolve once the runner publishes an event of the given type for this task,
// collecting every event seen along the way (so a test can assert on both the
// terminal boundary and what preceded it).
function watch(taskId: string, until: TaskStreamEvent["type"]): { events: TaskStreamEvent[]; done: Promise<void> } {
  const events: TaskStreamEvent[] = [];
  const done = new Promise<void>((resolve) => {
    const unsub = subscribe(taskId, (ev) => {
      events.push(ev);
      if (ev.type === until) { unsub(); resolve(); }
    });
  });
  return { events, done };
}

beforeEach(() => {
  runTurnMock.mockReset();
  clearAgentAuthBroken("claude");
});

describe("dead-login recovery", () => {
  it.each([
    "Unable to locate credentials",
    "AWS default-chain credential resolve timed out",
    "ExpiredToken: The security token included in the request is expired",
    "SSO session credentials have expired",
  ])("recognizes an AWS credential failure: %s", (message) => {
    expect(isAuthFailure(message)).toBe(true);
  });

  it("flags the agent instance-wide, offers a reconnect, and parks the queue instead of burning it", async () => {
    const project = createProject({ name: "P", repo_path: "" });
    const task = createTask({ project_id: project.id, title: "T", description: "d" });
    // Two follow-ups the user typed while the turn was live (what POST /messages
    // parks in pending_messages). They must survive the auth failure.
    addPendingMessage(task.id, task.generation, "and then deploy it");
    addPendingMessage(task.id, task.generation, "and write a test");

    // The session opens, then the credential turns out to be dead — the real
    // shape of an expired OAuth session (it fails at the API, not at spawn).
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "sess-1" };
      throw new Error(OAUTH_DEAD);
    });

    const w = watch(task.id, "turn_end");
    startTurn(task, project, "hi", "");
    await w.done;

    // The transcript carries the provider's own words AND the durable recovery
    // notice the UI turns into a "Reconnect Claude Code" button.
    const errMsg = listMessages(task.id).find((m) => m.role === "system" && m.content.includes(AUTH_EXPIRED_NOTICE));
    expect(errMsg).toBeTruthy();
    expect(errMsg!.content).toContain("OAuth session expired");
    // One ⚠ — the runner prefixes it, so the renderer must not add a second.
    expect(errMsg!.content.startsWith("⚠ ")).toBe(true);
    expect(errMsg!.content).not.toContain("⚠ ⚠");

    // The agent is flagged app-wide (one login, every task) and announced once,
    // which is what raises the titlebar banner in every open tab.
    const broken = getAgentAuthBroken("claude");
    expect(broken?.reason).toContain("OAuth session expired");
    const announced = w.events.filter((e) => e.type === "agent_auth");
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ agent: "claude", broken: true });

    // The queue is untouched — no dequeue, no second (identically failing) turn.
    expect(listPendingMessages(task.id)).toHaveLength(2);
    expect(w.events.some((e) => e.type === "dequeued")).toBe(false);
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    // …and the transcript says so, so the parked bubbles aren't a mystery.
    expect(listMessages(task.id).some((m) => m.content.includes("kept in the queue"))).toBe(true);

    // The turn still settles: nothing is left spinning.
    expect(getTask(task.id)!.running).toBe(0);
  });

  it("clears the flag once a turn runs again, and tells every tab", async () => {
    const project = createProject({ name: "P2", repo_path: "" });
    const task = createTask({ project_id: project.id, title: "T2", description: "d" });
    // Broken by an earlier turn (or a previous app run — the flag is persisted).
    markAgentAuthBroken("claude", OAUTH_DEAD, 1);

    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "sess-ok" };
      yield { type: "done", sessionId: "sess-ok" };
    });

    const w = watch(task.id, "turn_end");
    startTurn(task, project, "hi", "");
    await w.done;

    // A completed turn is stronger proof than `claude auth status` — it used the
    // same path a real turn takes.
    expect(getAgentAuthBroken("claude")).toBeNull();
    expect(w.events.filter((e) => e.type === "agent_auth")).toEqual([
      { type: "agent_auth", agent: "claude", broken: false, reason: null },
    ]);
  });

  it("leaves ordinary turn failures alone — no flag, and the queue still drains", async () => {
    const project = createProject({ name: "P3", repo_path: "" });
    const task = createTask({ project_id: project.id, title: "T3", description: "d" });
    addPendingMessage(task.id, task.generation, "follow-up");

    // Turn 1 fails on the work; turn 2 (the dequeued follow-up) succeeds.
    runTurnMock
      .mockImplementationOnce(async function* () {
        yield { type: "session", sessionId: "sess-a" };
        throw new Error("ENOSPC: no space left on device");
      })
      .mockImplementation(async function* () {
        yield { type: "session", sessionId: "sess-a" };
        yield { type: "done", sessionId: "sess-a" };
      });

    const w = watch(task.id, "dequeued");
    startTurn(task, project, "hi", "");
    await w.done;

    expect(getAgentAuthBroken("claude")).toBeNull();
    const msgs = listMessages(task.id);
    expect(msgs.some((m) => m.content.includes(AUTH_EXPIRED_NOTICE))).toBe(false);
    expect(msgs.some((m) => m.content.includes("ENOSPC"))).toBe(true);
    // The follow-up was dequeued and run: an unrelated failure doesn't park it.
    expect(listPendingMessages(task.id)).toHaveLength(0);
  });
});

describe("isAuthFailure — provider-agnostic dead-credential detection", () => {
  it("matches the Claude Code signatures", () => {
    expect(isAuthFailure(OAUTH_DEAD)).toBe(true);
    expect(isAuthFailure("Claude Code process exited with code 1: Invalid API key · Please run /login")).toBe(true);
    expect(isAuthFailure("API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"}}")).toBe(true);
  });

  it("matches the Codex signatures so a Codex task gets the same recovery", () => {
    expect(isAuthFailure("stream error: not logged in — please run `codex login`")).toBe(true);
    expect(isAuthFailure("401 Unauthorized: your ChatGPT session has expired")).toBe(true);
    expect(isAuthFailure("token refresh failed: invalid_grant")).toBe(true);
  });

  it("does not fire on unrelated failures (or on the other recoverable one)", () => {
    expect(isAuthFailure("API Error: 400 prompt is too long: 250000 tokens > 204698 maximum")).toBe(false);
    expect(isAuthFailure("rate limit exceeded, retry after 60s")).toBe(false);
    expect(isAuthFailure("ECONNRESET")).toBe(false);
    expect(isAuthFailure("Run ended: error_during_execution")).toBe(false);
    // A tool that hit a 404 on some unrelated endpoint isn't an auth problem.
    expect(isAuthFailure("request failed with status 404 not found")).toBe(false);
    expect(isAuthFailure("")).toBe(false);
    expect(isAuthFailure(null)).toBe(false);
    expect(isAuthFailure(undefined)).toBe(false);
  });
});
