import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { spawn as ptySpawn, type IPty } from "node-pty";
import { CLAUDE_CLI_PATH as CLAUDE } from "./config";

const run = promisify(execFile);

// The wizard's "Connect Claude" step, built on the `claude` CLI's headless
// OAuth (the documented per-user login — see docs/DEPLOY.md → "Per-user claude
// login"). `claude auth login` falls back to OAuth's manual paste-code flow
// when it can't open a browser: it prints an authorize URL and waits on
// `Paste code here if prompted >`. We drive it under a pseudo-tty (the CLI
// insists on a terminal), parse the URL so the UI can show it instead of
// burying it in scrollback, take the code the user pastes back, and confirm
// with `claude auth status`. All credential state the CLI writes lives under
// $HOME (~/.claude/.credentials.json), which is the user's persistent volume,
// so the login survives restarts with no extra plumbing.

// ---------- terminal-probe answering (shared shape with lib/github.ts) ----------
// Strip ANSI so our regexes see plain text; answer the cursor/colour probes the
// CLI's prompt library blocks on, or it never renders the URL.
const stripAnsi = (s: string) =>
  s
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    .replace(/\u001b[78]/g, "")
    .replace(/\u001b/g, "");

const TERM_QUERY = /\u001b(\]11;\?|\[6n|\[999;999f)/g;
function answerTermQueries(proc: IPty, chunk: string, size: { rows: number; cols: number }) {
  let sizeProbe = false;
  for (const m of chunk.matchAll(TERM_QUERY)) {
    if (m[1] === "]11;?") proc.write("\u001b]11;rgb:1e1e/1e1e/1e1e\u001b\\");
    else if (m[1] === "[999;999f") sizeProbe = true;
    else {
      proc.write(sizeProbe ? `\u001b[${size.rows};${size.cols}R` : "\u001b[1;1R");
      sizeProbe = false;
    }
  }
}

// ---------- login session ----------

export interface ClaudeLoginSession {
  status: "starting" | "awaiting" | "submitting" | "success" | "error";
  url: string | null; // the authorize URL to open in a browser
  email: string | null; // account email once logged in
  plan: string | null; // "Max" | "Pro" | "API" | null
  error: string | null;
  log: string; // tail of the (ANSI-stripped) terminal output, for the UI's pane
}

interface LoginState extends ClaudeLoginSession {
  proc: IPty | null;
  buf: string;
  answered: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}

const SIZE = { rows: 50, cols: 200 };

// One session per app instance (= per user). Kept on globalThis so every route
// chunk that imports this module shares the same live session.
const g = globalThis as unknown as { __orchClaudeLogin?: LoginState };

const tail = (buf: string) => buf.split("\n").slice(-14).join("\n").trim();

const publicView = (st: LoginState): ClaudeLoginSession => ({
  status: st.status,
  url: st.url,
  email: st.email,
  plan: st.plan,
  error: st.error,
  log: tail(st.buf),
});

export function getClaudeLogin(): ClaudeLoginSession | null {
  return g.__orchClaudeLogin ? publicView(g.__orchClaudeLogin) : null;
}

export function cancelClaudeLogin(): void {
  const st = g.__orchClaudeLogin;
  if (!st) return;
  if (st.timer) clearTimeout(st.timer);
  try {
    st.proc?.kill();
  } catch {}
  delete g.__orchClaudeLogin;
}

/**
 * Start (or rejoin) the device-style login. Resolves once the authorize URL
 * has been parsed — or earlier on error — so the UI can render it immediately;
 * the CLI keeps running, parked on its paste-code prompt, until submitClaudeCode().
 */
export async function startClaudeLogin(): Promise<ClaudeLoginSession> {
  const cur = g.__orchClaudeLogin;
  if (cur && (cur.status === "starting" || cur.status === "awaiting" || cur.status === "submitting")) {
    return awaitUrl();
  }
  cancelClaudeLogin(); // clear any finished (success/error) session

  const st: LoginState = {
    status: "starting",
    url: null,
    email: null,
    plan: null,
    error: null,
    log: "",
    proc: null,
    buf: "",
    answered: new Set(),
    timer: null,
  };
  g.__orchClaudeLogin = st;

  try {
    // BROWSER=true: when the CLI tries to open the URL it runs /bin/true on a
    // headless box instead of erroring — the user opens the link we surface.
    st.proc = ptySpawn(CLAUDE, ["auth", "login"], {
      name: "xterm-256color",
      cols: SIZE.cols,
      rows: SIZE.rows,
      cwd: os.homedir(),
      env: { ...process.env, BROWSER: "true" } as Record<string, string>,
    });
  } catch (e) {
    st.status = "error";
    st.error = `could not start claude: ${e instanceof Error ? e.message : String(e)}`;
    return publicView(st);
  }

  // OAuth codes are short-lived; reap a forgotten session after 15 min.
  st.timer = setTimeout(() => {
    if (st.status !== "success") {
      st.status = "error";
      st.error = "login timed out — start again to get a fresh link";
      try {
        st.proc?.kill();
      } catch {}
    }
  }, 15 * 60_000);

  // Reply to a prompt the first time it appears (defensive — the documented
  // flow goes straight to the URL, but some CLI versions ask first).
  const answer = (key: string, when: RegExp, reply: string) => {
    if (!st.answered.has(key) && when.test(st.buf)) {
      st.answered.add(key);
      st.proc?.write(reply);
    }
  };

  st.proc.onData((chunk) => {
    if (st.proc) answerTermQueries(st.proc, chunk, SIZE);
    if (st.status === "success" || st.status === "error") return;
    st.buf += stripAnsi(chunk);

    answer("theme", /(Choose|Select).{0,20}theme/i, "\r"); // accept default theme
    answer("trust", /trust the files in this folder/i, "\r"); // yes, trust home
    answer("method", /Select login method|How would you like to (log|sign) in/i, "\r"); // top option = subscription

    if (!st.url) {
      const m = st.buf.match(/https:\/\/(?:claude|console\.anthropic|platform\.claude|www\.claude)[^\s"']*/i);
      if (m) {
        st.url = m[0].replace(/[).,]+$/, "");
        st.status = "awaiting";
      }
    }

    // Some versions print success before exit; confirm + capture account async.
    if (st.status === "submitting" && /Login success|Logged in|successfully (logged|authenticated)|You are now (logged|signed)/i.test(st.buf)) {
      void finishSuccess(st);
    }
    if (st.status === "submitting" && /Invalid code|incorrect|expired|did not match|authentication failed/i.test(st.buf)) {
      st.status = "error";
      st.error = "that code didn't work — start again to get a fresh link";
    }
  });

  st.proc.onExit(({ exitCode }) => {
    if (st.timer) clearTimeout(st.timer);
    if (st.status === "success") return;
    // The command exits when login completes. Trust auth status over scraping.
    if (st.status === "submitting" || exitCode === 0) {
      void finishSuccess(st);
      return;
    }
    st.status = "error";
    const last = st.buf
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/paste code|visit|http/i.test(l))
      .slice(-3)
      .join(" · ");
    st.error = last || `claude auth login exited with code ${exitCode}`;
  });

  return awaitUrl();
}

/** Hand the pasted authorization code to the waiting CLI prompt. */
export async function submitClaudeCode(code: string): Promise<ClaudeLoginSession> {
  const st = g.__orchClaudeLogin;
  if (!st || !st.proc) return { status: "error", url: null, email: null, plan: null, error: "no login in progress", log: "" };
  const clean = code.trim();
  if (!clean) return publicView(st);
  st.status = "submitting";
  st.proc.write(`${clean}\r`);
  // Give the exchange a moment to land (success/exit flips status); the UI
  // keeps polling getClaudeLogin() either way.
  const deadline = Date.now() + 12_000;
  while (st.status === "submitting" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  return publicView(st);
}

// Confirm a login by reading the CLI's own auth status, capturing email + plan.
async function finishSuccess(st: LoginState) {
  if (st.status === "success") return;
  const s = await claudeStatus();
  if (s.authenticated) {
    st.status = "success";
    st.email = s.email;
    st.plan = s.plan;
    if (st.timer) clearTimeout(st.timer);
    try {
      st.proc?.kill();
    } catch {}
  } else if (st.status === "submitting") {
    st.status = "error";
    st.error = s.error || "login did not complete — please try again";
  }
}

// Resolve once the session leaves "starting" (URL parsed / error); give up
// after 20s and return whatever we have.
async function awaitUrl(): Promise<ClaudeLoginSession> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const st = g.__orchClaudeLogin;
    if (!st) return { status: "error", url: null, email: null, plan: null, error: "login session vanished", log: "" };
    if (st.status !== "starting" || Date.now() > deadline) return publicView(st);
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ---------- status + verify (used by the wizard's Verify step) ----------

export interface ClaudeStatus {
  authenticated: boolean;
  method: string | null; // raw "Login method" line
  email: string | null;
  plan: string | null; // "Max" | "Pro" | "API" | null
  error: string | null;
}

const planOf = (text: string): string | null =>
  /\bmax\b/i.test(text) ? "Max" : /\bpro\b/i.test(text) ? "Pro" : /api key|console|anthropic api/i.test(text) ? "API" : null;

export async function claudeStatus(): Promise<ClaudeStatus> {
  // `--text` prints a plain, parseable summary; fall back to bare status on
  // older CLIs that don't take the flag.
  for (const args of [["auth", "status", "--text"], ["auth", "status"]]) {
    try {
      const { stdout, stderr } = await run(CLAUDE, args, { timeout: 20_000, env: process.env });
      const text = `${stdout}\n${stderr}`;
      const method = text.match(/Login method:\s*(.+)/i)?.[1]?.trim() ?? null;
      const email = text.match(/Email:\s*(\S+@\S+)/i)?.[1] ?? text.match(/\b([\w.+-]+@[\w.-]+\.\w+)\b/)?.[1] ?? null;
      return { authenticated: true, method, email, plan: planOf(method ?? text), error: null };
    } catch (e) {
      const err = e as { code?: string; stdout?: string; stderr?: string };
      if (err.code === "ENOENT") return { authenticated: false, method: null, email: null, plan: null, error: "the claude CLI isn't installed in this workspace" };
      // Unknown-flag errors fall through to the next arg form; a real "not
      // logged in" exit (code 1) lands here on the bare-status attempt.
      if (args.length === 2) {
        const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
        return { authenticated: false, method: null, email: null, plan: null, error: out.trim() || "not logged in" };
      }
    }
  }
  return { authenticated: false, method: null, email: null, plan: null, error: "not logged in" };
}

/**
 * One-shot test turn through the same `claude` binary the SDK drives, proving
 * the connection actually produces output (not just that credentials exist).
 */
export async function verifyTurn(): Promise<{ ok: boolean; output: string; error: string | null }> {
  try {
    const { stdout } = await run(CLAUDE, ["-p", "Reply with exactly: OK"], {
      timeout: 90_000,
      env: process.env,
      maxBuffer: 1024 * 1024,
    });
    const out = stdout.trim();
    return { ok: out.length > 0, output: out, error: out.length > 0 ? null : "the test turn returned no output" };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    const msg = (err.stderr || err.message || "test turn failed").trim();
    return { ok: false, output: "", error: msg };
  }
}
