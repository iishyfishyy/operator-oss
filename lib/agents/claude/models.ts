import os from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_CLI_PATH } from "../../config";
import { CLAUDE_CAPABILITIES } from "./capabilities";
import { claudeModels } from "../modelDiscovery";

/** Initialize only: no user prompt, model generation, tools, or saved session. */
export async function discoverClaudeModels() {
  const abortController = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stream = query({ prompt: (async function* () { await gate; })(), options: {
    pathToClaudeCodeExecutable: CLAUDE_CLI_PATH, cwd: os.homedir(), abortController,
    tools: [], mcpServers: {}, strictMcpConfig: true, settingSources: ["user"], persistSession: false,
  } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rows = await Promise.race([
      stream.supportedModels(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error("Model discovery timed out")); abortController.abort(); }, 12_000); }),
    ]);
    return claudeModels(rows, CLAUDE_CAPABILITIES.models);
  } finally { clearTimeout(timer); release(); stream.close(); }
}
