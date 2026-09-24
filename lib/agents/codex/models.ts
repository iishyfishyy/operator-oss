import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import path from "node:path";
import os from "node:os";
import { CODEX_CLI_PATH } from "../../config";
import { CODEX_CAPABILITIES } from "./capabilities";
import { codexModels } from "../modelDiscovery";
import type { DiscoveredModels } from "../modelCatalog";

/** A short-lived metadata-only app-server connection. Never starts a thread. */
export function discoverCodexModels(): Promise<DiscoveredModels> {
  return new Promise((resolve, reject) => {
    const req = createRequire(path.join(process.cwd(), "package.json"));
    const args = CODEX_CLI_PATH ? ["app-server"] : [req.resolve("@openai/codex/bin/codex.js"), "app-server"];
    const child = spawn(CODEX_CLI_PATH || process.execPath, args, { cwd: os.homedir(), stdio: ["pipe", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout });
    const rows: unknown[] = [];
    let nextId = 2;
    let done = false;
    const cursors = new Set<string>();
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill();
      const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
      kill.unref();
      child.once("exit", () => clearTimeout(kill));
      if (error) reject(error); else resolve(codexModels(rows, CODEX_CAPABILITIES.models));
    };
    const timer = setTimeout(() => finish(new Error("Model discovery timed out")), 12_000);
    const send = (message: unknown) => { if (!done) child.stdin.write(JSON.stringify(message) + "\n"); };
    child.on("error", () => finish(new Error("Could not start Codex")));
    child.stdin.on("error", () => finish(new Error("Codex input closed")));
    child.on("exit", () => finish(new Error("Codex exited before returning models")));
    lines.on("line", line => {
      if (done) return;
      try {
        if (line.length > 2_000_000) throw new Error("Oversized response");
        const message = JSON.parse(line);
        if (message.id === undefined) return; // notifications
        if (message.error) throw new Error("Model request failed");
        if (message.id === 1) {
          send({ method: "initialized" });
          send({ id: nextId, method: "model/list", params: { includeHidden: false, limit: 100 } });
        } else if (message.id === nextId) {
          if (!Array.isArray(message.result?.data)) throw new Error("Invalid catalog");
          rows.push(...message.result.data);
          const cursor = message.result.nextCursor;
          if (rows.length > 500 || (cursor && cursors.has(cursor))) throw new Error("Invalid pagination");
          if (!cursor) return finish();
          cursors.add(cursor);
          send({ id: ++nextId, method: "model/list", params: { includeHidden: false, limit: 100, cursor } });
        }
      } catch { finish(new Error("Invalid model discovery response")); }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "operator", version: "1.0" } } });
  });
}
