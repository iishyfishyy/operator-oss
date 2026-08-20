import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import type { AgentLoginSession } from "../types";
import { bedrockAuthRefreshCommand, claudeSettingsEnv } from "./provider";

// The Bedrock counterpart of lib/claude-auth.ts's headless login: when the AWS
// SSO session behind CLAUDE_CODE_USE_BEDROCK expires, every turn dies on
// ExpiredToken and the reconnect banner appears — but the fix needs a browser
// (Okta/IdP + AWS device approval), which a detached server turn doesn't have.
// The browser that *does* exist is the one showing Operator. So this runs the
// instance's refresh command (lib/agents/claude/provider.ts resolves it from
// Claude Code's own `awsAuthRefresh` setting, or a device-code `aws sso login`
// for the configured SSO profile), scrapes the device URL + one-time code out
// of its output, and parks as an AgentLoginSession the existing login route/UI
// already know how to render. Device auth needs nothing pasted back: the user
// clicks, approves, the command exits 0, and the session flips to success.

/** Pull the verification URL and one-time user code out of device-flow output.
 *  Exported for tests. Handles both AWS CLI shapes: a single URL carrying
 *  ?user_code=XXXX-XXXX, and the older two-line "url, then code" print. */
export function scrapeDeviceAuth(text: string): { url: string | null; code: string | null } {
  const url = text.match(/https:\/\/[^\s"'<>)]+/)?.[0]?.replace(/[.,]+$/, "") ?? null;
  let code: string | null = null;
  if (url) {
    try {
      code = new URL(url).searchParams.get("user_code");
    } catch {}
  }
  code ??= text.match(/\b([A-Z0-9]{3,8}-[A-Z0-9]{3,8})\b/)?.[1] ?? null;
  return { url, code };
}

interface RefreshState extends AgentLoginSession {
  proc: ChildProcess | null;
  buf: string;
  timer: ReturnType<typeof setTimeout> | null;
}

// One refresh at a time per instance, HMR-surviving like every other bit of
// server state (see lib/events.ts et al).
const g = globalThis as unknown as { __orchBedrockRefresh?: RefreshState };

const tail = (buf: string) => buf.split("\n").slice(-14).join("\n").trim();

const publicView = (st: RefreshState): AgentLoginSession => ({
  status: st.status,
  url: st.url,
  code: st.code,
  email: st.email,
  plan: st.plan,
  error: st.error,
  log: tail(st.buf),
});

export function getBedrockRefresh(): AgentLoginSession | null {
  return g.__orchBedrockRefresh ? publicView(g.__orchBedrockRefresh) : null;
}

export function cancelBedrockRefresh(): void {
  const st = g.__orchBedrockRefresh;
  if (!st) return;
  if (st.timer) clearTimeout(st.timer);
  try {
    st.proc?.kill();
  } catch {}
  delete g.__orchBedrockRefresh;
}

/**
 * Start (or rejoin) the AWS credential refresh. Resolves once the device URL is
 * parsed — or on error — so the UI can render the click-to-open link; the
 * command keeps polling AWS until the user approves in the browser.
 */
export async function startBedrockRefresh(): Promise<AgentLoginSession> {
  const cur = g.__orchBedrockRefresh;
  if (cur && (cur.status === "starting" || cur.status === "awaiting")) return awaitUrl();
  cancelBedrockRefresh(); // clear a finished (success/error) session

  const command = bedrockAuthRefreshCommand();
  const st: RefreshState = {
    status: "starting",
    url: null,
    code: null,
    email: null,
    plan: null,
    error: null,
    log: "",
    proc: null,
    buf: "",
    timer: null,
  };
  g.__orchBedrockRefresh = st;

  if (!command) {
    st.status = "error";
    st.error = "no AWS refresh command is configured — set awsAuthRefresh in ~/.claude/settings.json or use an SSO profile";
    return publicView(st);
  }

  try {
    // Overlay Claude Code's settings.json env block (AWS_PROFILE, AWS_REGION…)
    // so the refresh sees the same AWS config the agent's turns do, even when
    // it was configured via /setup-bedrock rather than the shell environment.
    st.proc = spawn(command, {
      shell: true,
      cwd: os.homedir(),
      env: { ...process.env, ...claudeSettingsEnv(), BROWSER: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    st.status = "error";
    st.error = `could not start the AWS refresh: ${e instanceof Error ? e.message : String(e)}`;
    return publicView(st);
  }

  // Device codes are short-lived; reap a forgotten session after 15 min.
  st.timer = setTimeout(() => {
    if (st.status !== "success") {
      st.status = "error";
      st.error = "the AWS sign-in timed out — start again to get a fresh code";
      try {
        st.proc?.kill();
      } catch {}
    }
  }, 15 * 60_000);

  const onData = (chunk: Buffer) => {
    if (st.status === "success" || st.status === "error") return;
    st.buf += chunk.toString("utf8");
    if (!st.url) {
      const { url, code } = scrapeDeviceAuth(st.buf);
      if (url) {
        st.url = url;
        st.code = code;
        st.status = "awaiting";
      }
    }
  };
  st.proc.stdout?.on("data", onData);
  st.proc.stderr?.on("data", onData);

  st.proc.on("error", (e) => {
    if (st.timer) clearTimeout(st.timer);
    st.status = "error";
    st.error = `AWS refresh failed to run: ${e.message}`;
  });

  st.proc.on("exit", (exitCode) => {
    if (st.timer) clearTimeout(st.timer);
    if (st.status === "success" || st.status === "error") return;
    if (exitCode === 0) {
      st.status = "success";
      st.plan = "AWS";
      return;
    }
    st.status = "error";
    const last = st.buf
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/https?:\/\//i.test(l))
      .slice(-3)
      .join(" · ");
    st.error = last || `the AWS refresh command exited with code ${exitCode}`;
  });

  return awaitUrl();
}

// Resolve once the session leaves "starting" (URL parsed / error / a command
// that refreshed silently and exited); give up after 20s and return as-is.
async function awaitUrl(): Promise<AgentLoginSession> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const st = g.__orchBedrockRefresh;
    if (!st) return { status: "error", url: null, email: null, plan: null, error: "refresh session vanished", log: "" };
    if (st.status !== "starting" || Date.now() > deadline) return publicView(st);
    await new Promise((r) => setTimeout(r, 150));
  }
}
