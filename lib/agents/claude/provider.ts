import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const enabled = (value: unknown) => ["1", "true", "on"].includes(String(value ?? "").toLowerCase());

type Env = Record<string, string | undefined>;

// ~/.claude/settings.json is Claude Code's own config surface — the same file
// /setup-bedrock writes. Operator never invents Bedrock config of its own: it
// reads what Claude Code will use (the SDK loads all filesystem setting sources
// by default), so the app and the agent can't disagree about the provider.
function readClaudeSettings(env: Env): { env?: Record<string, unknown>; awsAuthRefresh?: unknown } | null {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Whether this Operator process is configured to route Claude through AWS. */
export function isBedrockConfigured(env: Env = process.env): boolean {
  if (enabled(env.CLAUDE_CODE_USE_BEDROCK) || enabled(env.CLAUDE_CODE_USE_MANTLE)) return true;
  const settings = readClaudeSettings(env);
  return enabled(settings?.env?.CLAUDE_CODE_USE_BEDROCK) || enabled(settings?.env?.CLAUDE_CODE_USE_MANTLE);
}

/** The env block from ~/.claude/settings.json, stringified — the variables
 *  Claude Code injects into its own session (AWS_PROFILE, AWS_REGION, model
 *  mappings). Callers overlay these onto process.env so commands Operator runs
 *  on Claude's behalf (an SSO refresh) see the same AWS config the agent does. */
export function claudeSettingsEnv(env: Env = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  const block = readClaudeSettings(env)?.env;
  if (block && typeof block === "object") {
    for (const [k, v] of Object.entries(block)) if (v != null) out[k] = String(v);
  }
  return out;
}

// A config value Claude Code would see: its settings.json env block wins over
// the inherited process env, matching how the CLI applies that block.
const effective = (name: string, env: Env): string | null => {
  const v = claudeSettingsEnv(env)[name] ?? env[name];
  return v && v.trim() ? v.trim() : null;
};

/** The per-family model ids Claude Code's aliases resolve to on Bedrock
 *  (ANTHROPIC_DEFAULT_*_MODEL), plus the session default (ANTHROPIC_MODEL).
 *  On Bedrock a bare "opus"/"sonnet"/"haiku" alias only works when its mapping
 *  is set, so the model picker offers exactly these. */
export function bedrockDefaultModels(env: Env = process.env): {
  opus: string | null;
  sonnet: string | null;
  haiku: string | null;
  default: string | null;
} {
  return {
    opus: effective("ANTHROPIC_DEFAULT_OPUS_MODEL", env),
    sonnet: effective("ANTHROPIC_DEFAULT_SONNET_MODEL", env),
    haiku: effective("ANTHROPIC_DEFAULT_HAIKU_MODEL", env),
    default: effective("ANTHROPIC_MODEL", env),
  };
}

// Does ~/.aws/config give this profile an SSO identity? Cheap INI walk: find the
// profile's section and look for any sso_* key (legacy sso_start_url or the
// newer sso_session reference). Gates the fallback refresh command so we never
// offer "refresh your SSO sign-in" to a static-key or bearer-token setup.
function awsProfileUsesSso(profile: string, env: Env): boolean {
  const file = env.AWS_CONFIG_FILE || path.join(os.homedir(), ".aws", "config");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  const header = profile === "default" ? /^\[(?:default|profile default)\]$/ : new RegExp(`^\\[profile ${profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]$`);
  let inSection = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inSection = header.test(line);
      continue;
    }
    if (inSection && /^sso_/i.test(line)) return true;
  }
  return false;
}

/** The command that refreshes this instance's AWS credentials interactively,
 *  when one is known. Two sources, both standard Claude Code / AWS surfaces:
 *  the `awsAuthRefresh` setting in ~/.claude/settings.json (Claude Code's own
 *  hook for exactly this), else a device-code `aws sso login` for the
 *  configured AWS_PROFILE when that profile is SSO-based. null = Operator has
 *  no way to refresh (static keys, bearer token) — the UI keeps its
 *  "reconfigure and restart" guidance instead. */
export function bedrockAuthRefreshCommand(env: Env = process.env): string | null {
  const settings = readClaudeSettings(env);
  const custom = settings?.awsAuthRefresh;
  if (typeof custom === "string" && custom.trim()) return custom.trim();
  const profile = effective("AWS_PROFILE", env);
  if (profile && awsProfileUsesSso(profile, env)) {
    // --use-device-code prints a URL + one-time code instead of needing a local
    // browser; --no-browser stops the CLI trying to open one on a headless box.
    return `aws sso login --profile "${profile}" --use-device-code --no-browser`;
  }
  return null;
}
