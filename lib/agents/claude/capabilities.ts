// Claude Code's capability descriptor — what the agent can do, as data
// (rendered into the UI's pickers via GET /api/agents). Split out of driver.ts
// so it can be read without importing the Agent SDK: serverExternalPackages
// make the SDK an async external under Turbopack, and that async-ness poisons
// every transitive importer (see lib/agents/capabilities.ts). A task row's
// null model/reasoning/permission means "inherit the driver default", so the
// lists carry only explicit choices.

import { cachedModels } from "../modelCatalog";
import { agentReasoningOptions } from "../reasoning";
import type { AgentCapabilities, AgentModelOption } from "../types";
import { isBedrockConfigured, bedrockDefaultModels } from "./provider";

// Persist and pass exact CLI model IDs, never moving family aliases. Older
// tasks with aliases still run unchanged; new selections pin the named version.
// Native 1M models need no duplicate [1m] choice on the Anthropic API.
// https://code.claude.com/docs/en/model-config
const K200 = 200_000;
const M1 = 1_000_000;

export const CLAUDE_CAPABILITIES: AgentCapabilities = {
  models: [
    { value: "claude-opus-5-5", label: "Opus 5.5", sub: "complex coding · 1M context", contextWindow: M1, group: "Latest" },
    { value: "claude-sonnet-5", label: "Sonnet 5", sub: "routine coding · 1M context", contextWindow: M1, group: "Latest" },
    { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5", sub: "fast, lightweight tasks", contextWindow: K200, group: "Latest", reasoningEfforts: [] },
    { value: "claude-fable-5-1", label: "Fable 5.1", sub: "most capable · 1M context", contextWindow: M1, group: "Latest" },
    { value: "claude-opus-5", label: "Opus 5", sub: "previous Opus · 1M context", contextWindow: M1, group: "Previous versions" },
    { value: "claude-fable-5", label: "Fable 5", sub: "previous Fable · 1M context", contextWindow: M1, group: "Previous versions" },
    { value: "claude-opus-4-8", label: "Opus 4.8", sub: "1M context", contextWindow: M1, group: "Previous versions" },
    { value: "claude-opus-4-7", label: "Opus 4.7", sub: "1M context", contextWindow: M1, group: "Previous versions" },
    { value: "claude-opus-4-6", label: "Opus 4.6", sub: "200K context", contextWindow: K200, group: "Previous versions" },
    { value: "claude-opus-4-6[1m]", label: "Opus 4.6 (1M)", sub: "extended context", contextWindow: M1, group: "Previous versions" },
    { value: "claude-sonnet-4-6", label: "Sonnet 4.6", sub: "200K context", contextWindow: K200, group: "Previous versions" },
    { value: "claude-sonnet-4-6[1m]", label: "Sonnet 4.6 (1M)", sub: "extended context", contextWindow: M1, group: "Previous versions" },
  ],
  // Claude Code's effort levels (/effort), verbatim. Only the fallback: the live
  // catalog carries each model's own supportedEffortLevels, and the agent-wide
  // list is rebuilt from those (claudeCapabilities below).
  reasoningOptions: ["low", "medium", "high", "xhigh", "max"].map((l) => ({ value: l, label: l, sub: "" })),
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
  supportsCustomModels: true,
  supportsBedrock: true,
  apiKeyHint: "sk-ant-…",
  loginStyle: "paste_code",
};

// Bedrock uses configured inference-profile IDs/ARNs. Persist those exact IDs
// too: a later family mapping change must not silently reroute a pinned task.
// Opaque ARNs remain opaque; don't invent a model version for them.
const bedrockWindow = (id: string) =>
  /claude-sonnet-5|claude-fable-5|\[1m\]/i.test(id) ? M1 : K200;

function bedrockModels(env: Record<string, string | undefined>): AgentModelOption[] {
  const ids = bedrockDefaultModels(env);
  const families = [
    ["opus", "Opus", "everyday complex work"],
    ["sonnet", "Sonnet", "efficient for routine tasks"],
    ["haiku", "Haiku", "fastest, lowest cost"],
  ] as const;
  return families
    .filter(([family]) => ids[family])
    .map(([family, label]) => ({
      value: ids[family] as string,
      label: ids[family] as string,
      sub: `${label} mapping in AWS config`,
      contextWindow: bedrockWindow(ids[family] as string),
      group: "Mapped in AWS config",
    }))
    .filter((model, index, models) => models.findIndex((m) => m.value === model.value) === index);
}

/** The live capability descriptor: the Anthropic-hosted catalog normally, a
 *  Bedrock-shaped model list when the instance routes Claude through AWS.
 *  Computed per read because the provider is instance config, not code. */
export function claudeCapabilities(env: Record<string, string | undefined> = process.env): AgentCapabilities {
  if (!isBedrockConfigured(env)) {
    const models = (env === process.env ? cachedModels("claude")?.models : undefined) ?? CLAUDE_CAPABILITIES.models;
    return { ...CLAUDE_CAPABILITIES, models, reasoningOptions: agentReasoningOptions(models, CLAUDE_CAPABILITIES.reasoningOptions) };
  }
  return { ...CLAUDE_CAPABILITIES, models: bedrockModels(env) };
}
