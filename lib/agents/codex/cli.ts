// Which `codex` CLI Operator drives. OpenAI gates its model catalog by CLI
// version (model/list on an old CLI silently omits newer models), so a stale
// binary means missing models. Unless CODEX_CLI_PATH pins one, every Codex call
// (turns, one-shots, model discovery, login/verify) runs the newest of the
// bundled @openai/codex dependency and a copy Operator keeps current itself
// under DB_DIR/codex-cli/<version>. SDK-free: modelCatalog.ts imports this.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { DB_DIR, CODEX_CLI_PATH, CODEX_AUTO_UPDATE } from "../../config";

type Install = { version: string; launcher: string; packageJson: string };

const ROOT = path.join(DB_DIR, "codex-cli");
const STATE = path.join(ROOT, "state.json");
const CHECK_EVERY = 6 * 60 * 60 * 1000;
const KEEP = 2; // the previous version may still be serving a running turn
const g = globalThis as typeof globalThis & { __codexUpdate?: Promise<void> };

const parts = (v: string) => v.split(/[.-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function read(packageJson: string, needPlatform: boolean): Install | undefined {
  try {
    const { version } = JSON.parse(fs.readFileSync(packageJson, "utf8"));
    const launcher = path.join(path.dirname(packageJson), "bin", "codex.js");
    if (typeof version !== "string" || !fs.existsSync(launcher)) return undefined;
    // The native binary ships as an optional platform package; a partial install lacks it.
    const platform = `codex-${process.platform}-${process.arch}`;
    const dir = path.dirname(packageJson);
    if (needPlatform && ![path.join(dir, "..", platform), path.join(dir, "node_modules", "@openai", platform)].some(p => fs.existsSync(path.join(p, "package.json")))) return undefined;
    return { version, launcher, packageJson };
  } catch { return undefined; }
}

function bundled(): Install | undefined {
  try {
    return read(createRequire(path.join(process.cwd(), "package.json")).resolve("@openai/codex/package.json"), false);
  } catch { return undefined; }
}

function managed(): Install[] {
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(ROOT).filter(d => /^\d+\.\d+\.\d+$/.test(d)); } catch { /* none yet */ }
  return dirs
    .map(d => read(path.join(ROOT, d, "node_modules", "@openai", "codex", "package.json"), true))
    .filter((i): i is Install => !!i)
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** The newest usable install, or undefined when CODEX_CLI_PATH pins the binary. */
export function codexInstall(): Install | undefined {
  if (CODEX_CLI_PATH) return undefined;
  const [best] = [bundled(), ...managed()].filter((i): i is Install => !!i).sort((a, b) => compareVersions(b.version, a.version));
  return best;
}

/** argv prefix for spawning the CLI directly (append the subcommand). */
export function codexCommand(): { command: string; args: string[] } {
  if (CODEX_CLI_PATH) return { command: CODEX_CLI_PATH, args: [] };
  const install = codexInstall();
  return install ? { command: process.execPath, args: [install.launcher] } : { command: "codex", args: [] };
}

/**
 * codexPathOverride for @openai/codex-sdk. Undefined lets the SDK resolve its
 * bundled binary itself (keeping the package's bundled PATH helpers); a newer
 * managed copy is handed over as its npm launcher, which does the same.
 */
export function codexSdkPath(): string | undefined {
  if (CODEX_CLI_PATH) return CODEX_CLI_PATH;
  const install = codexInstall();
  return install && install.packageJson !== bundled()?.packageJson ? install.launcher : undefined;
}

/** File whose stat identifies the active CLI (model-catalog cache key). */
export function codexIdentityFile(): string {
  return CODEX_CLI_PATH || codexInstall()?.packageJson || path.join(process.cwd(), "node_modules/@openai/codex/package.json");
}

const run = promisify(execFile);

function npmBin(): string {
  const local = path.join(path.dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
  return fs.existsSync(local) ? local : "npm";
}

async function install(version: string): Promise<void> {
  const dir = path.join(ROOT, version);
  const temp = `${dir}.${process.pid}.tmp`;
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({ private: true }));
  try {
    await run(npmBin(), ["install", "--no-audit", "--no-fund", "--omit=dev", `@openai/codex@${version}`], {
      cwd: temp, timeout: 5 * 60_000, env: { ...process.env, NODE_ENV: "production" },
    });
    const got = read(path.join(temp, "node_modules", "@openai", "codex", "package.json"), true);
    if (got?.version !== version) throw new Error(`Codex ${version} install incomplete`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(temp, dir);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  for (const old of managed().slice(KEEP)) fs.rmSync(path.resolve(old.packageJson, "../../../.."), { recursive: true, force: true });
}

/**
 * Fire-and-forget: at most every CHECK_EVERY, ask the npm registry for the
 * latest @openai/codex and install it if it beats what we'd run. The model
 * catalog keys on the CLI's package.json, so the next discovery re-lists.
 */
export function maybeUpdateCodex(): void {
  if (CODEX_CLI_PATH || !CODEX_AUTO_UPDATE || g.__codexUpdate) return;
  let checkedAt = 0;
  try { checkedAt = JSON.parse(fs.readFileSync(STATE, "utf8")).checkedAt || 0; } catch { /* first run */ }
  if (Date.now() - checkedAt < CHECK_EVERY) return;
  g.__codexUpdate = (async () => {
    try {
      fs.mkdirSync(ROOT, { recursive: true });
      fs.writeFileSync(STATE, JSON.stringify({ checkedAt: Date.now() }));
      const res = await fetch("https://registry.npmjs.org/@openai/codex/latest", { signal: AbortSignal.timeout(10_000) });
      const latest = res.ok ? (await res.json()).version : undefined;
      if (typeof latest !== "string" || !/^\d+\.\d+\.\d+$/.test(latest)) return;
      const current = codexInstall()?.version;
      if (current && compareVersions(latest, current) <= 0) return;
      await install(latest);
    } catch (e) {
      console.warn("[codex] CLI auto-update failed:", e instanceof Error ? e.message : e);
    } finally {
      g.__codexUpdate = undefined;
    }
  })();
}
