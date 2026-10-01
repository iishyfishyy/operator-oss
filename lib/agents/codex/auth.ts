// The wizard's "Connect Codex" flow, built on the `codex` CLI's ChatGPT device
// authorization (`codex login --device-auth`): it prints an auth URL plus a
// short one-time code, then polls OpenAI until the user enters that code in a
// browser — no code is pasted back into the terminal (unlike Claude's login).
// We spawn it, surface the URL + code so the UI can show them instead of
// burying them in scrollback, and confirm with `codex login status`. All
// credential state lives under $HOME (~/.codex/auth.json) — the user's
// persistent volume — so the login survives restarts with no extra plumbing.
//
// Unlike Claude's login (lib/claude-auth.ts) codex device-auth needs no pty:
// it writes to a plain pipe even without a TTY, so we use child_process.spawn.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { codexCommand } from "./cli";
import { hasOpenAiKey, looksLikeOpenAiKey, setOpenAiKey, clearOpenAiKey } from "../../openai-key";
import type { AgentApiKeyAuth, AgentAuthStatus, AgentLoginSession, AgentVerifyResult } from "../types";
import type { TurnUsage } from "../../types";
import { addInternalUsage } from "../../internalUsage";
import { resolveCodexModel } from "./pricing";
import { codexUsage, type CodexTokenUsage } from "./usage";

const run = promisify(execFile);

// Same CLI the turns run (lib/agents/codex/cli.ts), resolved per call so an
// auto-update takes effect without a restart.
const codex = (...argv: string[]) => { const c = codexCommand(); return [c.command, [...c.args, ...argv]] as const; };

// Strip ANSI colour/escape sequences so our regexes see plain text.
const stripAnsi = (s: string) =>
  s
    .replace(/\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\][^]*(?:|\\)?/g, "")
    .replace(//g, "");

// ---------- status + verify (used by the wizard's Verify step) ----------

const planOf = (text: string): string | null =>
  /chatgpt/i.test(text) ? "ChatGPT" : /api key|api-key/i.test(text) ? "API" : null;

// The API-key path reports connected off the env/file the codex children read,
// even when `codex login status` is terse about it.
const apiKeyStatus = (): AgentAuthStatus =>
  ({ authenticated: true, method: "OpenAI API key", email: null, plan: "API", error: null });

export async function codexStatus(): Promise<AgentAuthStatus> {
  // Key check BEFORE the CLI's own view: `codex login status` is keyed on
  // ~/.codex/auth.json and can report a ChatGPT login while an OPENAI_API_KEY
  // in the env is what the codex children actually bill (issue #4). After the
  // boot strip (lib/env-keys.mjs) a key here is always deliberate, so when one
  // is present the honest status is API-key billing, whatever the CLI says.
  if (hasOpenAiKey()) return apiKeyStatus();
  try {
    const { stdout, stderr } = await run(...codex("login", "status"), { timeout: 20_000, env: process.env });
    const text = stripAnsi(`${stdout}\n${stderr}`);
    if (/logged in|signed in/i.test(text)) {
      const method = text.match(/(?:logged|signed) in (?:using|with)\s*(.+)/i)?.[1]?.trim() ?? null;
      const email = text.match(/\b([\w.+-]+@[\w.-]+\.\w+)\b/)?.[1] ?? null;
      return { authenticated: true, method, email, plan: planOf(method ?? text), error: null };
    }
    return { authenticated: false, method: null, email: null, plan: null, error: text.trim() || "not logged in" };
  } catch (e) {
    const err = e as { code?: string; stdout?: string; stderr?: string };
    if (err.code === "ENOENT")
      return { authenticated: false, method: null, email: null, plan: null, error: "the codex CLI isn't installed in this workspace" };
    // A "not logged in" exit (nonzero) lands here.
    const out = stripAnsi(`${err.stdout ?? ""}${err.stderr ?? ""}`);
    return { authenticated: false, method: null, email: null, plan: null, error: out.trim() || "not logged in" };
  }
}

// The Codex "I have an API key instead" path (OpenAI mirror of the Claude one).
// Persisted + applied by lib/openai-key.ts; the `codex` children read
// OPENAI_API_KEY from the env we set.
export const codexApiKey: AgentApiKeyAuth = {
  hint: "sk-…",
  looksValid: looksLikeOpenAiKey,
  has: hasOpenAiKey,
  set: setOpenAiKey,
  clear: clearOpenAiKey,
};

/**
 * One-shot test turn through the same `codex` binary the driver drives, proving
 * the connection actually produces output. Read-only sandbox, git check skipped
 * so it runs from $HOME without a repo.
 */
export async function verifyCodexTurn(): Promise<AgentVerifyResult> {
  const started = Date.now();
  try {
    const { stdout } = await run(
      ...codex("exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "Reply with exactly: OK"),
      { timeout: 90_000, env: process.env, maxBuffer: 4 * 1024 * 1024, cwd: os.homedir() }
    );
    const { output, usage } = parseVerifyEvents(stdout);
    const ok = output.length > 0;
    addInternalUsage({
      job: "verify", agent: "codex", requested_agent: "codex", ok,
      ms: Date.now() - started, usage,
    });
    return { ok, output, error: ok ? null : "the test turn returned no output" };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const { usage } = parseVerifyEvents(err.stdout ?? "");
    const msg = stripAnsi(err.stderr || err.message || "test turn failed").trim();
    addInternalUsage({
      job: "verify", agent: "codex", requested_agent: "codex", ok: false,
      ms: Date.now() - started, usage,
    });
    return { ok: false, output: "", error: msg };
  }
}

function parseVerifyEvents(stdout: string): { output: string; usage?: TurnUsage } {
  let output = "";
  let usage: TurnUsage | undefined;
  for (const line of stripAnsi(stdout).split("\n")) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as {
        type?: string;
        item?: { type?: string; text?: string };
        usage?: CodexTokenUsage;
      };
      if (raw.type === "item.completed" && raw.item?.type === "agent_message") output = raw.item.text ?? "";
      if (raw.type === "turn.completed" && raw.usage) usage = codexUsage(raw.usage, resolveCodexModel(null));
    } catch {}
  }
  return { output: output.trim(), usage };
}

// ---------- device-auth login session ----------

interface LoginState extends AgentLoginSession {
  proc: ChildProcess | null;
  buf: string;
  code: string | null; // the one-time device code, echoed in the log for the user
  timer: ReturnType<typeof setTimeout> | null;
}

// One session per app instance (= per user), kept on globalThis so every route
// chunk that imports this module shares the same live session (mirrors
// lib/claude-auth.ts).
const g = globalThis as unknown as { __orchCodexLogin?: LoginState };

const tail = (buf: string) => buf.split("\n").slice(-14).join("\n").trim();

const publicView = (st: LoginState): AgentLoginSession => ({
  status: st.status,
  url: st.url,
  code: st.code,
  email: st.email,
  plan: st.plan,
  error: st.error,
  log: tail(st.buf),
});

export function getCodexLogin(): AgentLoginSession | null {
  return g.__orchCodexLogin ? publicView(g.__orchCodexLogin) : null;
}

export function cancelCodexLogin(): void {
  const st = g.__orchCodexLogin;
  if (!st) return;
  if (st.timer) clearTimeout(st.timer);
  try {
    st.proc?.kill();
  } catch {}
  delete g.__orchCodexLogin;
}

/**
 * Start (or rejoin) the device-code login. Resolves once the auth URL + code
 * are parsed — or earlier on error — so the UI can render them immediately; the
 * CLI keeps running, polling OpenAI, until the user authorizes in a browser.
 */
export async function startCodexLogin(): Promise<AgentLoginSession> {
  const cur = g.__orchCodexLogin;
  if (cur && (cur.status === "starting" || cur.status === "awaiting" || cur.status === "submitting")) {
    return awaitUrl();
  }
  cancelCodexLogin(); // clear any finished (success/error) session

  const st: LoginState = {
    status: "starting",
    url: null,
    email: null,
    plan: null,
    error: null,
    log: "",
    proc: null,
    buf: "",
    code: null,
    timer: null,
  };
  g.__orchCodexLogin = st;

  try {
    st.proc = spawn(...codex("login", "--device-auth"), {
      cwd: os.homedir(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    st.status = "error";
    st.error = `could not start codex: ${e instanceof Error ? e.message : String(e)}`;
    return publicView(st);
  }

  // Device codes are short-lived (~15 min); reap a forgotten session after that.
  st.timer = setTimeout(() => {
    if (st.status !== "success") {
      st.status = "error";
      st.error = "login timed out — start again to get a fresh code";
      try {
        st.proc?.kill();
      } catch {}
    }
  }, 15 * 60_000);

  const onData = (chunk: Buffer) => {
    if (st.status === "success" || st.status === "error") return;
    st.buf += stripAnsi(chunk.toString());
    if (!st.url) {
      const m = st.buf.match(/https:\/\/(?:auth\.openai\.com|chatgpt\.com|platform\.openai\.com)\/\S*/i);
      if (m) {
        st.url = m[0].replace(/[).,]+$/, "");
        st.status = "awaiting";
      }
    }
    if (!st.code) {
      // The one-time code, e.g. "TURL-7HQVR": groups of letters/digits joined by
      // a dash. Anchor on the "code" wording so we don't grab a stray token.
      const m = st.buf.match(/one-?time code[^\n]*\n\s*([A-Z0-9]{3,6}-[A-Z0-9]{3,6})/i) || st.buf.match(/\b([A-Z0-9]{3,6}-[A-Z0-9]{3,6})\b/);
      if (m) st.code = m[1];
    }
    if (/(login|logged) ?in|success|authenticated|you are now/i.test(st.buf)) {
      void finishSuccess(st);
    } else if (/expired|denied/i.test(st.buf)) {
      // Don't hard-fail on a stray "error"/"invalid" word mid-stream — only on
      // exit; but capture an explicit expiry/denial immediately.
      st.status = "error";
      st.error = "the device code was denied or expired — start again";
    }
  };
  st.proc.stdout?.on("data", onData);
  st.proc.stderr?.on("data", onData);

  st.proc.on("exit", (exitCode) => {
    if (st.status === "success" || st.status === "error") {
      if (st.timer) clearTimeout(st.timer);
      return;
    }
    // Keep the reaper armed until settleAfterExit resolves — clearing it here
    // used to leave a session that never settled pinned at "awaiting" forever,
    // locking the onboarding wizard's Continue button on fresh machines.
    void settleAfterExit(st, exitCode);
  });

  return awaitUrl();
}

/**
 * Device-code login needs no code paste-back (the user enters the code in the
 * browser), so this is a no-op that just returns the current view — kept for
 * interface parity with the Claude login. The UI polls getCodexLogin() until
 * the flow completes on its own.
 */
export async function submitCodexCode(_code: string): Promise<AgentLoginSession> {
  const st = g.__orchCodexLogin;
  if (!st) return { status: "error", url: null, email: null, plan: null, error: "no login in progress", log: "" };
  return publicView(st);
}

async function finishSuccess(st: LoginState) {
  if (st.status === "success") return;
  const s = await codexStatus();
  if (s.authenticated) {
    st.status = "success";
    st.email = s.email;
    st.plan = s.plan;
    if (st.timer) clearTimeout(st.timer);
    try {
      st.proc?.kill();
    } catch {}
  } else if (st.status === "awaiting" || st.status === "submitting") {
    // Not done yet — keep waiting (the CLI is still polling); leave status as-is.
  }
}

// The child exited — the session MUST settle to success or error from here.
// codex login exits 0 once the browser authorization completes, but the
// auth.json write can land a beat after exit, and `codex login status` can
// hiccup (enterprise-managed configs prepend warnings and sometimes exit
// nonzero), so retry the status check before declaring the login dead.
async function settleAfterExit(st: LoginState, exitCode: number | null) {
  const expectSuccess = exitCode === 0 || st.status === "awaiting" || st.status === "submitting";
  let lastErr: string | null = null;
  for (let i = 0; i < (expectSuccess ? 5 : 1); i++) {
    // The reaper (or a stdout-driven finishSuccess) may settle us mid-loop.
    if (st.status === "success" || st.status === "error") return;
    const s = await codexStatus();
    if (s.authenticated) {
      st.status = "success";
      st.email = s.email;
      st.plan = s.plan;
      if (st.timer) clearTimeout(st.timer);
      return;
    }
    lastErr = s.error;
    await new Promise((r) => setTimeout(r, 1_000 * (i + 1)));
  }
  if (st.status === "success" || st.status === "error") return;
  st.status = "error";
  if (st.timer) clearTimeout(st.timer);
  if (expectSuccess) {
    st.error = `codex login finished but \`codex login status\` reports: ${lastErr || "not logged in"} — try Verify connection, or start again`;
    return;
  }
  const last = st.buf
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/http|code|browser|sign in/i.test(l))
    .slice(-3)
    .join(" · ");
  st.error = last || `codex login exited with code ${exitCode}`;
}

// Resolve once the session leaves "starting" (URL parsed / error); give up
// after 20s and return whatever we have.
async function awaitUrl(): Promise<AgentLoginSession> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const st = g.__orchCodexLogin;
    if (!st) return { status: "error", url: null, email: null, plan: null, error: "login session vanished", log: "" };
    if (st.status !== "starting" || Date.now() > deadline) return publicView(st);
    await new Promise((r) => setTimeout(r, 150));
  }
}
