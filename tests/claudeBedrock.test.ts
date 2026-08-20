import { describe, expect, it } from "vitest";
import { bedrockStatusFromJson } from "@/lib/agents/claude/auth-status";
import { isUsageLimit } from "@/lib/usageLimit";

describe("Claude Bedrock status", () => {
  it("recognizes Claude Code's third-party provider status", () => {
    expect(bedrockStatusFromJson(JSON.stringify({
      loggedIn: true,
      authMethod: "third_party",
      apiProvider: "bedrock",
    }))).toEqual({
      authenticated: true,
      method: "Amazon Bedrock",
      email: null,
      plan: "AWS",
      error: null,
      provider: "bedrock",
    });
  });

  it("does not relabel Anthropic auth or malformed output", () => {
    expect(bedrockStatusFromJson('{"loggedIn":true,"apiProvider":"firstParty"}')).toBeNull();
    expect(bedrockStatusFromJson("not json")).toBeNull();
  });
});

describe("Bedrock throttling", () => {
  it.each(["ThrottlingException", "TooManyRequestsException"])("parks queued work on %s", (message) => {
    expect(isUsageLimit(message)).toBe(true);
  });
});
