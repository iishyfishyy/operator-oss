import { afterEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ start: vi.fn(), resume: vi.fn(), error: "", throws: false, policy: "never" }));
vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    startThread(options: unknown) { sdk.start(options); return this.thread(); }
    resumeThread(id: string, options: unknown) { sdk.resume(id, options); return this.thread(); }
    thread() {
      return { async runStreamed() {
        if (sdk.throws) throw new Error(sdk.error);
        return { events: (async function* () {
          if (sdk.error) yield { type: "error", message: sdk.error };
        })() };
      } };
    }
  },
}));

vi.mock("@/lib/config", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/config")>(),
  get CODEX_APPROVAL_POLICY() { return sdk.policy; },
}));

import { codexDriver } from "@/lib/agents/codex/driver";
import { createProject, createTask, deleteProject, getTask, getSetting, setSetting, updateTask } from "@/lib/store";
import { GET, PATCH } from "@/app/api/settings/route";
import { CODEX_FULL_ACCESS_BLOCKED_NOTICE, isApprovalBlocked } from "@/lib/approvalFailure";

const projects: string[] = [];
function fixture() {
  const project = createProject({ name: "Permissions" });
  projects.push(project.id);
  const task = createTask({ project_id: project.id, title: "T", description: "", agent: "codex" });
  return { project, task };
}
async function run(f: ReturnType<typeof fixture>) {
  const events = [];
  for await (const event of codexDriver.runTurn(f.task, f.project, "hello")) events.push(event);
  return events;
}
afterEach(() => {
  for (const id of projects.splice(0)) deleteProject(id);
  for (const key of ["default_permission_mode:codex", "default_permission_mode", "codex_approval_downgraded"]) setSetting(key, null);
  vi.clearAllMocks(); sdk.error = ""; sdk.throws = false; sdk.policy = "never";
});

describe("Codex permissions", () => {
  it.each([null, "bypassPermissions", "unknown"])("keeps %s sandboxed by default", async (mode) => {
    const f = fixture(); f.task.permission_mode = mode;
    await run(f);
    expect(sdk.start).toHaveBeenCalledWith(expect.objectContaining({ sandboxMode: "workspace-write", approvalPolicy: "never", networkAccessEnabled: true }));
  });

  it("persists a Settings default and applies it to launch and resume", async () => {
    await PATCH(new Request("http://localhost/api/settings", { method: "PATCH", body: JSON.stringify({ "default_permission_mode:codex": "fullAccess" }) }));
    expect((await (await GET()).json())["default_permission_mode:codex"]).toBe("fullAccess");
    const f = fixture(); await run(f);
    const expected = expect.objectContaining({ sandboxMode: "danger-full-access", approvalPolicy: "never" });
    expect(sdk.start).toHaveBeenCalledWith(expected);
    f.task.session_id = "existing-thread"; await run(f);
    expect(sdk.resume).toHaveBeenCalledWith("existing-thread", expected);
    setSetting("default_permission_mode:codex", "plan"); await run(f);
    expect(sdk.resume).toHaveBeenLastCalledWith("existing-thread", expect.objectContaining({ sandboxMode: "read-only", networkAccessEnabled: false }));
  });

  it.each(["plan", "bypassPermissions", "fullAccess"])("persists task override %s ahead of the default", async (mode) => {
    const f = fixture(); setSetting("default_permission_mode:codex", mode === "fullAccess" ? "plan" : "fullAccess");
    updateTask(f.task.id, { permission_mode: mode });
    f.task = getTask(f.task.id)!; await run(f);
    expect(sdk.start).toHaveBeenCalledWith(expect.objectContaining({ sandboxMode: mode === "plan" ? "read-only" : mode === "fullAccess" ? "danger-full-access" : "workspace-write" }));
    updateTask(f.task.id, { permission_mode: null }); f.task = getTask(f.task.id)!; await run(f);
    expect(sdk.start).toHaveBeenLastCalledWith(expect.objectContaining({ sandboxMode: mode === "fullAccess" ? "read-only" : "danger-full-access" }));
  });

  it("retains approval negotiation except for explicit Full access", async () => {
    setSetting("codex_approval_downgraded", "1"); const f = fixture(); await run(f);
    expect(sdk.start).toHaveBeenLastCalledWith(expect.objectContaining({ approvalPolicy: "on-request" }));
    f.task.permission_mode = "fullAccess"; await run(f);
    expect(sdk.start).toHaveBeenLastCalledWith(expect.objectContaining({ approvalPolicy: "never" }));
  });

  it.each([false, true])("explains managed rejection (throws=%s) without promising automatic recovery", async (throws) => {
    const f = fixture(); f.task.permission_mode = "fullAccess";
    sdk.throws = throws;
    sdk.error = "Configured value for `approval_policy` is disallowed by requirements";
    const events = await run(f);
    const error = events.find(e => e.type === "error");
    expect(error).toMatchObject({ content: expect.stringContaining(CODEX_FULL_ACCESS_BLOCKED_NOTICE) });
    if (error?.type === "error") expect(isApprovalBlocked(error.content)).toBe(false);
    expect(getSetting("codex_approval_downgraded")).toBeNull();
  });


  it.each(["inherit", "on-request"])("Full access explicitly requests never with instance policy %s", async (policy) => {
    sdk.policy = policy;
    const f = fixture(); await run(f);
    if (policy === "inherit") expect(sdk.start.mock.calls[0][0]).not.toHaveProperty("approvalPolicy");
    else expect(sdk.start).toHaveBeenLastCalledWith(expect.objectContaining({ approvalPolicy: policy }));
    f.task.permission_mode = "fullAccess"; await run(f);
    expect(sdk.start).toHaveBeenLastCalledWith(expect.objectContaining({ sandboxMode: "danger-full-access", approvalPolicy: "never" }));
  });

  it("keeps internal utility jobs read-only despite the Full access default", async () => {
    setSetting("default_permission_mode:codex", "fullAccess");
    const f = fixture();
    await codexDriver.summarizeTranscript!("transcript", f.project);
    expect(sdk.start).toHaveBeenCalledWith(expect.objectContaining({ sandboxMode: "read-only", networkAccessEnabled: false }));
  });

  it("explains managed sandbox rejection", async () => {
    const f = fixture(); f.task.permission_mode = "fullAccess";
    sdk.error = "Configured value for `sandbox_mode` is disallowed by requirements";
    expect(await run(f)).toContainEqual({ type: "error", content: expect.stringContaining(CODEX_FULL_ACCESS_BLOCKED_NOTICE) });
  });
});
