// Claude Code's capability descriptor — what the agent can do, as data
// (rendered into the UI's pickers via GET /api/agents). Split out of driver.ts
// so it can be read without importing the Agent SDK: serverExternalPackages
// make the SDK an async external under Turbopack, and that async-ness poisons
// every transitive importer (see lib/agents/capabilities.ts). A task row's
// null model/reasoning/permission means "inherit the driver default", so the
// lists carry only explicit choices.

import type { AgentCapabilities } from "../types";

export const CLAUDE_CAPABILITIES: AgentCapabilities = {
  models: [
    { value: "fable", label: "Fable", sub: "most powerful", contextWindow: 1_000_000 },
    { value: "opus", label: "Opus", sub: "most capable", contextWindow: 200_000 },
    { value: "sonnet", label: "Sonnet", sub: "balanced", contextWindow: 200_000 },
    { value: "haiku", label: "Haiku", sub: "fastest", contextWindow: 200_000 },
  ],
  reasoningOptions: [
    { value: "off", label: "Off", sub: "no extended thinking" },
    { value: "think", label: "Think", sub: "light reasoning" },
    { value: "think_hard", label: "Think hard", sub: "deeper reasoning" },
    { value: "ultrathink", label: "Ultrathink", sub: "maximum reasoning" },
  ],
  permissionModes: [
    { value: "bypassPermissions", label: "Auto-run", sub: "bypass permissions (default)" },
    { value: "acceptEdits", label: "Accept edits", sub: "auto-accept file edits" },
    { value: "plan", label: "Plan mode", sub: "propose a plan, don't edit" },
  ],
  supportsAsks: true,
  supportsMcpTools: true,
  reportsCostUsd: true,
  costIsEstimated: false,
  supportsResume: true,
  apiKeyHint: "sk-ant-…",
  loginStyle: "paste_code",
};
