// Codex's capability descriptor — what the agent can do, as data (rendered
// into the UI's pickers via GET /api/agents). Split out of driver.ts so it can
// be read without importing @openai/codex-sdk (an async external under
// Turbopack — see lib/agents/capabilities.ts). Null model = inherit codex's
// built-in default (see DEFAULT_CODEX_MODEL in ./pricing).

import { cachedModels } from "../modelCatalog";
import { agentReasoningOptions } from "../reasoning";
import type { AgentCapabilities } from "../types";
import { codexApiKey } from "./auth";

// The live CLI catalog budgets 272k for these models, independently of their
// larger API maximum. Use the CLI window for the context gauge.
const CTX = 272_000;

export const CODEX_CAPABILITIES: AgentCapabilities = {
  // Checked 2026-09-23 against Codex 0.156.1 model/list and
  // https://learn.chatgpt.com/docs/models. Exact IDs pass through to the SDK.
  // Recheck the live catalog when updating the CLI; availability varies by
  // account. GPT-5.4 / Mini retired from ChatGPT sign-in, so they are custom
  // IDs only (existing tasks and API-key users can still send them unchanged).
  // Keep groups contiguous so each section gets one picker heading.
  models: [
    { value: "gpt-6-astra", label: "GPT-6 Astra", sub: "most capable for the hardest end-to-end work", contextWindow: CTX, group: "Latest" },
    { value: "gpt-6-sol", label: "GPT-6 Sol", sub: "complex coding and agentic workflows", contextWindow: CTX, group: "Latest" },
    { value: "gpt-6-luna", label: "GPT-6 Luna", sub: "fast, efficient focused coding", contextWindow: CTX, group: "Latest" },
    { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", sub: "previous frontier agentic coding model", contextWindow: CTX, group: "Previous versions" },
    { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", sub: "balanced agentic coding for everyday work", contextWindow: CTX, group: "Previous versions" },
    { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", sub: "fast and affordable agentic coding", contextWindow: CTX, group: "Previous versions" },
    { value: "gpt-5.5", label: "GPT-5.5", sub: "retires from ChatGPT sign-in October 14, 2026", contextWindow: CTX, group: "Previous versions" },
  ],
  // Codex's reasoning efforts with the CLI's own descriptions (model/list,
  // checked 2026-09-26 on codex-cli 0.154). Only the fallback: the live catalog
  // carries each model's supportedReasoningEfforts + default, and the
  // agent-wide list is rebuilt from those (codexCapabilities below).
  reasoningOptions: [
    { value: "low", label: "low", sub: "Fast responses with lighter reasoning" },
    { value: "medium", label: "medium", sub: "Balances speed and reasoning depth for everyday tasks" },
    { value: "high", label: "high", sub: "Greater reasoning depth for complex problems" },
    { value: "xhigh", label: "xhigh", sub: "Extra high reasoning depth for complex problems" },
    { value: "max", label: "max", sub: "Maximum reasoning depth for the hardest problems" },
    { value: "ultra", label: "ultra", sub: "Maximum reasoning with automatic task delegation" },
  ],
  // Only the modes with a real codex analog are declared. bypassPermissions maps
  // to workspace-write + approvals-never (auto-run); plan maps to a read-only
  // sandbox. acceptEdits has no distinct codex analog (writes already auto-apply)
  // and on-request approvals can't be answered non-interactively, so neither is
  // offered — both fall back to bypassPermissions.
  permissionModes: [
    { value: "bypassPermissions", label: "Auto-run", sub: "workspace write, no approvals (default)" },
    { value: "fullAccess", label: "Full access", sub: "access files and execute outside the task worktree with your account permissions; no approvals" },
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
  supportsCustomModels: true,
  apiKeyHint: codexApiKey.hint,
  loginStyle: "device_code",
};

export function codexCapabilities(): AgentCapabilities {
  const models = cachedModels("codex")?.models ?? CODEX_CAPABILITIES.models;
  return { ...CODEX_CAPABILITIES, models, reasoningOptions: agentReasoningOptions(models, CODEX_CAPABILITIES.reasoningOptions) };
}
