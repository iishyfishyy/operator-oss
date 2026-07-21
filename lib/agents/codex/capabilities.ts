// Codex's capability descriptor — what the agent can do, as data (rendered
// into the UI's pickers via GET /api/agents). Split out of driver.ts so it can
// be read without importing @openai/codex-sdk (an async external under
// Turbopack — see lib/agents/capabilities.ts). Model values are the
// gpt-5.x-codex family the CLI accepts; null model = inherit codex's built-in
// default. Context window mirrors GPT-5's ~272k input.

import type { AgentCapabilities } from "../types";
import { codexApiKey } from "./auth";

const CTX = 272_000;

export const CODEX_CAPABILITIES: AgentCapabilities = {
  models: [
    { value: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max", sub: "most capable", contextWindow: CTX },
    { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini", sub: "faster, cheaper", contextWindow: CTX },
  ],
  // Off/Think/Think hard/Ultrathink → codex's model_reasoning_effort scale.
  reasoningOptions: [
    { value: "off", label: "Off", sub: "minimal reasoning" },
    { value: "think", label: "Think", sub: "light reasoning" },
    { value: "think_hard", label: "Think hard", sub: "deeper reasoning" },
    { value: "ultrathink", label: "Ultrathink", sub: "maximum reasoning" },
  ],
  // Only the modes with a real codex analog are declared. bypassPermissions maps
  // to workspace-write + approvals-never (auto-run); plan maps to a read-only
  // sandbox. acceptEdits has no distinct codex analog (writes already auto-apply)
  // and on-request approvals can't be answered non-interactively, so neither is
  // offered — both fall back to bypassPermissions.
  permissionModes: [
    { value: "bypassPermissions", label: "Auto-run", sub: "workspace write, no approvals (default)" },
    { value: "plan", label: "Plan mode", sub: "read-only, propose without editing" },
  ],
  // Interactive asks arrive via the MCP bridge's ask_user tool (the card UI and
  // /answer route are shared with Claude's AskUserQuestion flow).
  supportsAsks: true,
  // The orchestrator's suggest_task / expose_service tools reach Codex through
  // the portable stdio MCP bridge (scripts/orch-mcp.mjs), registered per turn
  // by the driver — the same tools the Claude driver mounts in-process.
  supportsMcpTools: true,
  // ChatGPT-plan auth reports tokens only — no billed dollar figure — so the
  // cost the driver emits is an estimate (tokens × published API prices for
  // the resolved model). The descriptor stays honest: reportsCostUsd=false,
  // and costIsEstimated=true has the UI show the figure with an ~.
  reportsCostUsd: false,
  costIsEstimated: true,
  supportsResume: true,
  apiKeyHint: codexApiKey.hint,
  loginStyle: "device_code",
};
