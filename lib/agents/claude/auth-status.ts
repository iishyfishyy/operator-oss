import type { AgentAuthStatus } from "../types";

/** Parse Claude Code's machine-readable auth status when it identifies Bedrock. */
export function bedrockStatusFromJson(text: string): AgentAuthStatus | null {
  try {
    const status = JSON.parse(text) as {
      loggedIn?: boolean;
      authMethod?: string;
      apiProvider?: string;
    };
    if (!status.loggedIn || status.apiProvider !== "bedrock") return null;
    return {
      authenticated: true,
      method: "Amazon Bedrock",
      email: null,
      plan: "AWS",
      error: null,
      provider: "bedrock",
    };
  } catch {
    return null;
  }
}
