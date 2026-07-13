import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";

// The Claude driver module is mocked at the seam — the runner and the clear
// route resolve it via getDriver(task.agent) (lib/agents/registry.ts), and the
// registry maps "claude" to this module's export, so replacing it keeps the
// real SDK (and its env/auth needs) out of the test while still exercising the
// registry resolution. vi.hoisted lets the hoisted vi.mock factory reference
// these mocks.
const { runTurnMock, summarizeMock } = vi.hoisted(() => ({
  runTurnMock: vi.fn(),
  summarizeMock: vi.fn(),
}));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Claude Code",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown) =>
      runTurnMock(task, project, userText, ac),
    summarizeTranscript: (transcript: string, project: unknown) => summarizeMock(transcript, project),
  },
}));

import { createProject, createTask, getTask, listMessages, listSummaries, addMessage } from "@/lib/store";
import { startTurn } from "@/lib/runner";
import { subscribe } from "@/lib/events";
import { CONTEXT_OVERFLOW_NOTICE, isPromptTooLong } from "@/lib/promptLimits";
import { buildClippedTranscript, clipMessage } from "@/lib/transcript";
import { POST as clearPOST } from "@/app/api/tasks/[id]/clear/route";
import type { TaskStreamEvent } from "@/lib/types";

// Resolve once the runner publishes an event of the given type for this task.
function waitForEvent(taskId: string, type: TaskStreamEvent["type"]): Promise<void> {
  return new Promise((resolve) => {
    const unsub = subscribe(taskId, (ev) => {
      if (ev.type === type) {
        unsub();
        resolve();
      }
    });
  });
}

async function callClear(id: string) {
  const res = await clearPOST(new Request("http://test/clear", { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
  return (await res.json()) as { task?: { session_id: string | null; generation: number; started: number }; summary?: string; generation?: number };
}

beforeEach(() => {
  runTurnMock.mockReset();
  summarizeMock.mockReset();
  summarizeMock.mockResolvedValue("HANDOFF SUMMARY");
});

describe("prompt-too-long recovery", () => {
  it("poisons the session on a prompt-too-long turn, then /clear un-poisons it and the next turn starts fresh", async () => {
    const project = createProject({ name: "P", repo_path: "" });
    const task = createTask({ project_id: project.id, title: "T", description: "d" });

    // Turn 1: the SDK opens a session (init) and then the API rejects the turn
    // as too long — the exact poisoning sequence.
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "sess-poisoned" };
      yield { type: "error", content: "API Error: 400 prompt is too long: 250000 tokens > 204698 maximum" };
    });

    const ended = waitForEvent(task.id, "turn_end");
    startTurn(task, project, "hi", "");
    await ended;

    // Poisoned: session id persisted despite the failure, and the transcript
    // carries the durable recovery notice.
    const poisoned = getTask(task.id)!;
    expect(poisoned.session_id).toBe("sess-poisoned");
    const overflowMsg = listMessages(task.id).find(
      (m) => m.role === "system" && m.content.includes(CONTEXT_OVERFLOW_NOTICE)
    );
    expect(overflowMsg).toBeTruthy();
    // The raw API error stays visible alongside the notice.
    expect(overflowMsg!.content).toContain("prompt is too long");

    // Recovery: /clear resets the session and bumps the generation.
    const cleared = await callClear(task.id);
    expect(cleared.task?.session_id).toBeNull();
    expect(cleared.task?.generation).toBe(2);
    expect(cleared.task?.started).toBe(0);
    expect(cleared.generation).toBe(2);
    expect(listSummaries(task.id).length).toBe(1);
    expect(getTask(task.id)!.session_id).toBeNull();

    // Turn 2: a fresh send after the reset must NOT resume the poisoned session.
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "sess-fresh" };
      yield { type: "done", sessionId: "sess-fresh" };
    });
    const fresh = getTask(task.id)!;
    const ended2 = waitForEvent(task.id, "turn_end");
    startTurn(fresh, project, "second try", "");
    await ended2;

    // The driver was invoked with a task carrying no session id — a fresh run.
    const secondCall = runTurnMock.mock.calls[1];
    expect((secondCall[0] as { session_id: string | null }).session_id).toBeNull();
    expect(getTask(task.id)!.session_id).toBe("sess-fresh");
  });

  it("clips an oversized transcript before summarizing so /clear still produces a handoff", async () => {
    const project = createProject({ name: "P2", repo_path: "" });
    const task = createTask({ project_id: project.id, title: "T2", description: "d" });

    // A single giant pasted message in the current generation.
    const huge = "X".repeat(1_000_000);
    addMessage(task.id, task.generation, "user", huge);

    const cleared = await callClear(task.id);
    expect(cleared.summary).toBe("HANDOFF SUMMARY");
    expect(summarizeMock).toHaveBeenCalledTimes(1);
    const passed = summarizeMock.mock.calls[0][0] as string;
    // The 1 MB message never reaches summarizeTranscript verbatim.
    expect(passed.length).toBeLessThan(20_000);
    expect(passed).toContain("chars clipped");
  });
});

describe("isPromptTooLong — provider-agnostic context-overflow detection", () => {
  it("matches the Anthropic (Claude driver) signature", () => {
    expect(isPromptTooLong("API Error: 400 prompt is too long: 250000 tokens > 204698 maximum")).toBe(true);
  });

  it("matches the OpenAI/Codex signatures so Codex tasks get the recovery button too", () => {
    // The OpenAI API's structured rejection.
    expect(isPromptTooLong("Error code: 400 - context_length_exceeded")).toBe(true);
    expect(
      isPromptTooLong("This model's maximum context length is 272000 tokens. However, your messages resulted in 300000 tokens")
    ).toBe(true);
    expect(isPromptTooLong("Please reduce the length of the messages.")).toBe(true);
    // How the codex CLI phrases the same turn failure.
    expect(isPromptTooLong("turn failed: input is too long for the model's context window")).toBe(true);
    expect(isPromptTooLong("conversation exceeds the model's context window")).toBe(true);
  });

  it("does not fire on unrelated errors", () => {
    expect(isPromptTooLong("ECONNRESET")).toBe(false);
    expect(isPromptTooLong("rate limit exceeded")).toBe(false);
    expect(isPromptTooLong("")).toBe(false);
    expect(isPromptTooLong(null)).toBe(false);
    expect(isPromptTooLong(undefined)).toBe(false);
  });
});

describe("buildClippedTranscript / clipMessage", () => {
  it("passes small content through unchanged", () => {
    expect(clipMessage("hello", 4000)).toBe("hello");
    const out = buildClippedTranscript([{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }]);
    expect(out).toBe("USER: hi\n\nASSISTANT: yo");
  });

  it("clips a long message to head+tail with a marker", () => {
    const body = "A".repeat(50_000) + "TAILMARK";
    const out = clipMessage(body, 4000);
    expect(out.length).toBeLessThan(4200); // ~max plus the marker text
    expect(out).toContain("chars clipped");
    expect(out.startsWith("AAAA")).toBe(true);
    expect(out.endsWith("TAILMARK")).toBe(true);
  });

  it("caps the total by dropping the oldest messages and notes the omission", () => {
    const msgs = Array.from({ length: 200 }, (_, i) => ({ role: "user", content: `msg-${i} ` + "y".repeat(2000) }));
    const out = buildClippedTranscript(msgs, 4000, 50_000);
    expect(out.length).toBeLessThan(55_000);
    expect(out).toMatch(/^\(\d+ earlier messages omitted\)/);
    // The most recent message is kept (tail-preserving).
    expect(out).toContain("msg-199");
    expect(out).not.toContain("msg-0 ");
  });
});
