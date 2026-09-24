import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), query: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: mocks.spawn }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mocks.query }));
import { discoverCodexModels } from "@/lib/agents/codex/models";
import { discoverClaudeModels } from "@/lib/agents/claude/models";
let child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; kill: ReturnType<typeof vi.fn> };
let sent: Record<string, any>[];
beforeEach(() => {
  sent = [];
  child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn(() => true) });
  child.stdin.on("data", data => sent.push(JSON.parse(data.toString())));
  mocks.spawn.mockReturnValue(child);
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
const reply = (v: unknown) => child.stdout.write(JSON.stringify(v) + "\n");
it("initializes, follows model pages, and terminates without starting a thread", async () => {
  const result = discoverCodexModels();
  reply({ id: 1, result: {} });
  reply({ id: 2, result: { data: [{ model: "gpt-new", displayName: "New" }], nextCursor: "page2" } });
  reply({ id: 3, result: { data: [{ model: "gpt-next", displayName: "Next", isDefault: true }], nextCursor: null } });
  expect((await result).models.map(m => m.value)).toEqual(["gpt-new", "gpt-next"]);
  expect(sent.map(m => m.method)).toEqual(["initialize", "initialized", "model/list", "model/list"]);
  expect(sent[3].params.cursor).toBe("page2");
  expect(child.kill).toHaveBeenCalled();
});
it("terminates on protocol errors and unexpected exit", async () => {
  const result = discoverCodexModels();
  reply({ id: 1, error: { message: "failure" } });
  await expect(result).rejects.toThrow();
  expect(child.kill).toHaveBeenCalled();
});
it("bounds the time spent waiting for a silent Codex process", async () => {
  vi.useFakeTimers();
  const result = discoverCodexModels();
  const rejection = expect(result).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(12_000);
  await rejection;
  expect(child.kill).toHaveBeenCalled();
});
it("requests Claude metadata without sending a prompt and always closes the stream", async () => {
  const close = vi.fn();
  mocks.query.mockReturnValue({ supportedModels: async () => [{ value: "opus", resolvedModel: "claude-opus-6" }], close });
  expect((await discoverClaudeModels()).models[0].value).toBe("claude-opus-6");
  const args = mocks.query.mock.calls[0][0];
  expect(args.options).toMatchObject({ tools: [], persistSession: false, strictMcpConfig: true });
  expect(typeof args.prompt).not.toBe("string");
  expect(close).toHaveBeenCalled();
});
it("closes Claude when discovery fails", async () => {
  const close = vi.fn();
  mocks.query.mockReturnValue({ supportedModels: async () => { throw new Error("offline"); }, close });
  await expect(discoverClaudeModels()).rejects.toThrow("offline");
  expect(close).toHaveBeenCalled();
});
