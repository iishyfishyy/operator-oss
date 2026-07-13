import fs from "node:fs";
import path from "node:path";
import { DB_DIR } from "./config";

/**
 * "I have an API key instead" path for the Codex agent — the OpenAI mirror of
 * lib/anthropic-key.ts. Most instances connect Codex as the user's own ChatGPT
 * plan (lib/agents/codex/auth.ts, `codex login`), but a user can choose to bill
 * per-token with an OpenAI API key instead. We persist it to a 0600 file on the
 * volume — NOT the settings table, which is read wholesale by the client
 * `/api/settings` endpoint — and mirror it into process.env so the `codex`
 * children and SDK inherit it. loadPersistedOpenAiKey() re-applies it on boot
 * (production entrypoints strip OPENAI_API_KEY from the container env as a
 * hardening backstop, so the running process is the only place it lives).
 */
const KEY_PATH = path.join(DB_DIR, "openai-api-key");

export function hasOpenAiKey(): boolean {
  try {
    return fs.statSync(KEY_PATH).size > 0;
  } catch {
    return false;
  }
}

/** Loose shape check — real validation is the verify turn actually working. */
export function looksLikeOpenAiKey(key: string): boolean {
  return /^sk-[A-Za-z0-9_-]{20,}$/.test(key.trim());
}

export function setOpenAiKey(key: string): void {
  const k = key.trim();
  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.writeFileSync(KEY_PATH, k, { mode: 0o600 });
  try {
    fs.chmodSync(KEY_PATH, 0o600);
  } catch {}
  process.env.OPENAI_API_KEY = k;
}

export function clearOpenAiKey(): void {
  try {
    fs.rmSync(KEY_PATH, { force: true });
  } catch {}
  delete process.env.OPENAI_API_KEY;
}

/** Called once at DB init: re-apply a persisted key to this process's env. */
export function loadPersistedOpenAiKey(): void {
  try {
    const k = fs.readFileSync(KEY_PATH, "utf8").trim();
    if (k) process.env.OPENAI_API_KEY = k;
  } catch {
    /* no persisted key — ChatGPT-plan login (or nothing yet) */
  }
}
