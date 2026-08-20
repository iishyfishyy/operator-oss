// Claude Code's capability descriptor — what the agent can do, as data
// (rendered into the UI's pickers via GET /api/agents). Split out of driver.ts
// so it can be read without importing the Agent SDK: serverExternalPackages
// make the SDK an async external under Turbopack, and that async-ness poisons
// every transitive importer (see lib/agents/capabilities.ts). A task row's
// null model/reasoning/permission means "inherit the driver default", so the
// lists carry only explicit choices.

import type { AgentCapabilities, AgentModelOption } from "../types";
import { isBedrockConfigured, bedrockDefaultModels } from "./provider";

// Every value below is a string `claude --model` accepts: a family alias
// ("opus" → the current Opus), a `[1m]` variant (the 1M-context beta of that
// family), or a full model id for a pinned older version. The internal picker
// ids the CLI's own /model menu uses ("opus48", "sonnet46") are NOT accepted by
// --model — it 404s on them — so pins are spelled as full ids. Labels carry the
// version number on purpose: "Opus" alone can't tell you whether a turn ran on
// Opus 5 or 4.8, which is the whole question when a family alias moves.
//
// contextWindow is the window Claude Code actually runs, not the model's API
// maximum: a bare family alias runs the standard 200k window and the `[1m]`
// variant opts into the 1M beta. Fable is the exception — it's 1M natively
// (`fable[1m]` resolves to plain claude-fable-5), so there's no variant to list.
const K200 = 200_000;
const M1 = 1_000_000;

export const CLAUDE_CAPABILITIES: AgentCapabilities = {
  models: [
    { value: "fable", label: "Fable (latest)", sub: "most capable · 1M context", contextWindow: M1, group: "Latest" },
    { value: "opus", label: "Opus (provider default)", sub: "everyday complex work", contextWindow: K200, group: "Latest" },
    { value: "sonnet", label: "Sonnet (provider default)", sub: "efficient for routine tasks", contextWindow: K200, group: "Latest" },
    { value: "haiku", label: "Haiku (provider default)", sub: "fastest, lowest cost", contextWindow: K200, group: "Latest" },
    { value: "opusplan", label: "Opus Plan Mode", sub: "Opus while planning, Sonnet after", contextWindow: K200, group: "Latest" },
    { value: "opus[1m]", label: "Opus (1M)", sub: "long sessions, large codebases", contextWindow: M1, group: "1M context" },
    { value: "sonnet[1m]", label: "Sonnet (1M)", sub: "long sessions, large codebases", contextWindow: M1, group: "1M context" },
    { value: "opusplan[1m]", label: "Opus Plan Mode (1M)", sub: "plan on Opus, run on Sonnet 1M", contextWindow: M1, group: "1M context" },
    { value: "claude-opus-4-8", label: "Opus 4.8", sub: "previous Opus", contextWindow: K200, group: "Pinned versions" },
    { value: "claude-opus-4-8[1m]", label: "Opus 4.8 (1M)", sub: "previous Opus, 1M context", contextWindow: M1, group: "Pinned versions" },
    { value: "claude-sonnet-4-6", label: "Sonnet 4.6", sub: "previous Sonnet", contextWindow: K200, group: "Pinned versions" },
    { value: "claude-sonnet-4-6[1m]", label: "Sonnet 4.6 (1M)", sub: "previous Sonnet, 1M context", contextWindow: M1, group: "Pinned versions" },
    { value: "claude-opus-4-7", label: "Opus 4.7", sub: "legacy", contextWindow: K200, group: "Pinned versions" },
    { value: "claude-opus-4-6", label: "Opus 4.6", sub: "legacy", contextWindow: K200, group: "Pinned versions" },
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
  supportsCustomModels: true,
  supportsBedrock: true,
  apiKeyHint: "sk-ant-…",
  loginStyle: "paste_code",
};

// On Bedrock the Anthropic-hosted catalog above is mostly wrong: bare family
// aliases resolve only when the instance maps them (ANTHROPIC_DEFAULT_*_MODEL),
// the `[1m]`/opusplan variants and pinned Anthropic ids don't exist there, and
// the real default is whatever ANTHROPIC_MODEL / the AWS config says. So the
// Bedrock list is exactly the aliases this instance actually mapped — each
// labeled with the id it resolves to — and everything else goes through the
// picker's built-in "Default" (inherit) entry or the custom-model input
// (supportsCustomModels), which accepts Bedrock ids and inference-profile ARNs.
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
      value: family,
      label,
      sub: ids[family] as string,
      contextWindow: bedrockWindow(ids[family] as string),
      group: "Mapped in AWS config",
    }));
}

/** The live capability descriptor: the Anthropic-hosted catalog normally, a
 *  Bedrock-shaped model list when the instance routes Claude through AWS.
 *  Computed per read because the provider is instance config, not code. */
export function claudeCapabilities(env: Record<string, string | undefined> = process.env): AgentCapabilities {
  if (!isBedrockConfigured(env)) return CLAUDE_CAPABILITIES;
  return { ...CLAUDE_CAPABILITIES, models: bedrockModels(env) };
}
