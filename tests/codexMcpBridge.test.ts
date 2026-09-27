import { describe, it, expect } from "vitest";
import { orchestratorMcpConfig } from "@/lib/agents/codex/driver";
import type { Project, Task } from "@/lib/types";

// Pins the codex-side wiring of the orchestrator's stdio MCP bridge
// (scripts/orch-mcp.mjs), which gives Codex tasks suggest_task /
// expose_service / ask_user.
//
// The load-bearing field is `default_tools_approval_mode`. Codex gates MCP tool
// calls behind their own approval decision — `approval_policy = "never"` does
// NOT cover them. Under the default mode, `codex exec` (what the SDK spawns)
// has no approver, so every call to this server came back immediately as
// `error: "user cancelled MCP tool call"` and the tool silently never ran.
// Verified live on codex-cli 0.142.5: "auto" reproduces the cancellation,
// "approve" runs the tool. Valid modes are auto | prompt | approve.
const project = { id: "p1", name: "P", repo_path: "/tmp/repo" } as Project;
const task = { id: "t1", agent: "codex" } as Task;

describe("codex orchestrator MCP bridge config", () => {
  const server = (orchestratorMcpConfig(project, task) as Record<string, any>).mcp_servers.orchestrator;

  it("auto-approves the bridge's tools (non-interactive exec has no approver)", () => {
    expect(server.default_tools_approval_mode).toBe("approve");
  });

  it("keeps the parked-ask timeout far above any HTTP-scale default", () => {
    expect(server.tool_timeout_sec).toBeGreaterThanOrEqual(3600);
  });

  it("scopes the bridge to this task/project and authenticates it", () => {
    expect(server.env.ORCH_TASK_ID).toBe("t1");
    expect(server.env.ORCH_PROJECT_ID).toBe("p1");
    expect(server.env.ORCH_BASE_URL).toBeTruthy();
    expect(server.env).toHaveProperty("SERVICE_TOKEN");
  });

  it("spawns the bridge with an absolute node binary (no PATH dependency)", () => {
    expect(server.command).toBe(process.execPath);
    expect(server.args[0]).toMatch(/scripts[/\\]orch-mcp\.mjs$/);
  });

  it("mounts complete_step only for an auto-advance chain step", () => {
    expect(server.env).not.toHaveProperty("ORCH_COMPLETE_STEP");
  });
});
