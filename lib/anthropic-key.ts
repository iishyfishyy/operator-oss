import fs from "node:fs";
import path from "node:path";
import { DB_DIR } from "./config";

/**
 * "I have an API key instead" path of the onboarding wizard. Most instances
 * authenticate as the user's own Claude Max/Pro subscription (lib/claude-auth.ts,
 * `claude auth login`), but a user can choose to bill per-token with an Anthropic
 * API key instead. We persist it to a 0600 file on the volume — NOT the settings
 * table, which is read wholesale by the client `/api/settings` endpoint — and
 * mirror it into process.env so the SDK's `claude` children and every pty shell
 * spawned afterward inherit it. loadPersistedApiKey() re-applies it on boot
 * (production entrypoints strip ANTHROPIC_API_KEY from the container env as a
 * hardening backstop, so the running process is the only place it lives).
 */
const KEY_PATH = path.join(DB_DIR, "anthropic-api-key");

export function hasApiKey(): boolean {
  try {
    return fs.statSync(KEY_PATH).size > 0;
  } catch {
    return false;
  }
}

/** Loose shape check — real validation is the verify turn actually working. */
export function looksLikeApiKey(key: string): boolean {
  return /^sk-ant-[\w-]{20,}$/.test(key.trim());
}

export function setApiKey(key: string): void {
  const k = key.trim();
  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.writeFileSync(KEY_PATH, k, { mode: 0o600 });
  try {
    fs.chmodSync(KEY_PATH, 0o600);
  } catch {}
  process.env.ANTHROPIC_API_KEY = k;
}

export function clearApiKey(): void {
  try {
    fs.rmSync(KEY_PATH, { force: true });
  } catch {}
  delete process.env.ANTHROPIC_API_KEY;
}

/** Called once at DB init: re-apply a persisted key to this process's env. */
export function loadPersistedApiKey(): void {
  try {
    const k = fs.readFileSync(KEY_PATH, "utf8").trim();
    if (k) process.env.ANTHROPIC_API_KEY = k;
  } catch {
    /* no persisted key — subscription login (or nothing yet) */
  }
}
