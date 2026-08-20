import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isBedrockConfigured,
  claudeSettingsEnv,
  bedrockDefaultModels,
  bedrockAuthRefreshCommand,
} from "@/lib/agents/claude/provider";
import { claudeCapabilities, CLAUDE_CAPABILITIES } from "@/lib/agents/claude/capabilities";
import { scrapeDeviceAuth } from "@/lib/agents/claude/bedrock-auth";
import { tmpDir } from "./helpers";

const settingsDir = (settings: unknown): string => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
  return dir;
};

describe("Claude provider configuration", () => {
  it("detects Bedrock from the process environment", () => {
    expect(isBedrockConfigured({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe(true);
    expect(isBedrockConfigured({ CLAUDE_CODE_USE_BEDROCK: "false" })).toBe(false);
  });

  it("detects /setup-bedrock settings persisted by Claude Code", () => {
    const dir = settingsDir({ env: { CLAUDE_CODE_USE_BEDROCK: "true", AWS_PROFILE: "work" } });
    expect(isBedrockConfigured({ CLAUDE_CONFIG_DIR: dir })).toBe(true);
  });

  it("exposes the settings env block, stringified", () => {
    const dir = settingsDir({ env: { AWS_REGION: "us-east-1", MAX_THINKING_TOKENS: 4096 } });
    expect(claudeSettingsEnv({ CLAUDE_CONFIG_DIR: dir })).toEqual({
      AWS_REGION: "us-east-1",
      MAX_THINKING_TOKENS: "4096",
    });
  });
});

describe("Bedrock model mappings", () => {
  it("reads ANTHROPIC_DEFAULT_* mappings, settings block over process env", () => {
    const dir = settingsDir({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "global.anthropic.claude-opus-5" } });
    const ids = bedrockDefaultModels({
      CLAUDE_CONFIG_DIR: dir,
      ANTHROPIC_DEFAULT_OPUS_MODEL: "shadowed",
      ANTHROPIC_MODEL: "us.anthropic.claude-sonnet-5",
    });
    expect(ids.opus).toBe("global.anthropic.claude-opus-5");
    expect(ids.default).toBe("us.anthropic.claude-sonnet-5");
    expect(ids.sonnet).toBeNull();
    expect(ids.haiku).toBeNull();
  });

  it("serves only the mapped aliases when Bedrock is configured", () => {
    const dir = settingsDir({
      env: {
        CLAUDE_CODE_USE_BEDROCK: "1",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "global.anthropic.claude-opus-5",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "us.anthropic.claude-haiku-4-5",
      },
    });
    const caps = claudeCapabilities({ CLAUDE_CONFIG_DIR: dir });
    expect(caps.models.map((m) => m.value)).toEqual(["opus", "haiku"]);
    // The label carries the resolved id — that's the whole point of the entry.
    expect(caps.models[0].sub).toBe("global.anthropic.claude-opus-5");
    // No Anthropic-hosted pins or [1m] variants leak through.
    expect(caps.models.some((m) => m.value.includes("[1m]") || m.value.startsWith("claude-"))).toBe(false);
    // Everything else about the descriptor is unchanged.
    expect(caps.supportsCustomModels).toBe(true);
    expect(caps.reasoningOptions).toEqual(CLAUDE_CAPABILITIES.reasoningOptions);
  });

  it("keeps the Anthropic catalog when Bedrock is off", () => {
    const dir = settingsDir({});
    expect(claudeCapabilities({ CLAUDE_CONFIG_DIR: dir })).toEqual(CLAUDE_CAPABILITIES);
  });
});

describe("Bedrock auth refresh command", () => {
  it("prefers Claude Code's own awsAuthRefresh setting", () => {
    const dir = settingsDir({ awsAuthRefresh: "aws sso login --profile claude --use-device-code --no-browser" });
    expect(bedrockAuthRefreshCommand({ CLAUDE_CONFIG_DIR: dir })).toBe(
      "aws sso login --profile claude --use-device-code --no-browser"
    );
  });

  it("falls back to a device-code sso login for an SSO profile", () => {
    const dir = settingsDir({ env: { AWS_PROFILE: "work" } });
    const awsConfig = path.join(tmpDir(), "config");
    fs.writeFileSync(awsConfig, "[profile work]\nsso_session = corp\nregion = us-east-1\n");
    expect(bedrockAuthRefreshCommand({ CLAUDE_CONFIG_DIR: dir, AWS_CONFIG_FILE: awsConfig })).toBe(
      'aws sso login --profile "work" --use-device-code --no-browser'
    );
  });

  it("offers nothing for a static-credentials profile", () => {
    const dir = settingsDir({ env: { AWS_PROFILE: "work" } });
    const awsConfig = path.join(tmpDir(), "config");
    fs.writeFileSync(awsConfig, "[profile work]\nregion = us-east-1\n\n[profile other]\nsso_start_url = https://x.awsapps.com/start\n");
    expect(bedrockAuthRefreshCommand({ CLAUDE_CONFIG_DIR: dir, AWS_CONFIG_FILE: awsConfig })).toBeNull();
  });

  it("offers nothing with no profile and no awsAuthRefresh", () => {
    const dir = settingsDir({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } });
    expect(bedrockAuthRefreshCommand({ CLAUDE_CONFIG_DIR: dir, AWS_CONFIG_FILE: path.join(tmpDir(), "missing") })).toBeNull();
  });
});

describe("device-flow output scraping", () => {
  it("reads the single-URL shape with an embedded user code", () => {
    const out = "Attempting to automatically open the SSO authorization page...\n" +
      "If the browser does not open, visit:\n\nhttps://device.sso.us-west-2.amazonaws.com/?user_code=QRST-UVWX\n";
    expect(scrapeDeviceAuth(out)).toEqual({ url: "https://device.sso.us-west-2.amazonaws.com/?user_code=QRST-UVWX", code: "QRST-UVWX" });
  });

  it("reads the two-line url-then-code shape", () => {
    const out = "Open the following URL:\n\nhttps://device.sso.us-east-1.amazonaws.com/\n\nThen enter the code:\n\nABCD-1234\n";
    expect(scrapeDeviceAuth(out)).toEqual({ url: "https://device.sso.us-east-1.amazonaws.com/", code: "ABCD-1234" });
  });

  it("returns nulls until a URL appears", () => {
    expect(scrapeDeviceAuth("Signing in via SSO...")).toEqual({ url: null, code: null });
  });
});
