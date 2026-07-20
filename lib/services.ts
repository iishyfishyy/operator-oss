// Supervised per-project services.
//
// The orchestrator runs a project's dev server (and optional setup/test commands)
// as long-lived child processes OWNED BY THE SERVER PROCESS — not by a Claude turn
// or a browser tab. That's the whole point: `npm run dev` started here keeps
// running after the turn ends and after the tab closes, with its logs captured so
// the UI can show them on reconnect. Same lifetime model as the detached turn
// runner (lib/runner.ts): processes are reset when the server itself restarts —
// but the REGISTRY is not: every mutation writes through to the `services` table
// (lib/db.ts), and restoreServices() (server.js's boot ping to
// /api/instance/services-restore) re-starts every managed service whose
// desired_state is 'running', so a dev server survives a container restart at
// the same public URL. Because the children are detached, a crashed server
// (kill -9) leaves them orphaned; the persisted pid column lets the next boot
// reap the old process group before respawning (see reapOrphan), and a clean
// process exit SIGKILLs every managed group on the way out (installExitHook).
//
// State lives on globalThis so it survives Next's dev HMR module reloads (same
// pattern as lib/events.ts / lib/abort.ts). Each project also gets a stable PORT
// (projects.port), injected into every service's env so the dev server binds a
// predictable address the host-header router (lib/service-router.mjs) proxies
// public hostnames to: <slug>--<appHost>, e.g. calc--ishan.getoperator.dev.

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import { nanoid } from "nanoid";
import type {
  Project, ServiceInfo, ServiceKind, ServiceStatus, ServiceLogLine, ServiceEvent, ServiceVisibility,
} from "./types";
import { getDb } from "./db";
import { getProject, getSetting, setSetting } from "./store";
import { resolveFeatures } from "./features";
import { SERVICE_LOG_LINES } from "./config";
import { appHostFromEnv, serviceHostsEnabled, slugifyServiceName } from "./service-host.mjs";

// Per-service log ring buffer cap (lines) — ORCH_SERVICE_LOG_LINES, default 1500.
const LOG_CAP = SERVICE_LOG_LINES;

type Listener = (ev: ServiceEvent) => void;

interface Managed {
  projectId: string;
  name: string;
  kind: ServiceKind;
  command: string;
  port: number;
  proc: ChildProcess | null;
  status: ServiceStatus;
  exitCode: number | null;
  url: string | null;
  startedAt: number | null;
  managed: boolean; // false for an expose_service entry (we don't own the process)
  error: string | null; // supervisor-level failure (port taken, spawn failed)
  logs: ServiceLogLine[];
  // Persisted identity/sharing state (services table). slug is the public
  // hostname label — assigned once at first persist and never changed, so the
  // URL survives restarts and re-registrations.
  slug: string | null;
  visibility: ServiceVisibility;
  shareToken: string;
}

interface Registry {
  services: Map<string, Managed>; // key = `${projectId}:${name}`
  listeners: Map<string, Set<Listener>>; // by projectId
  // Instance-local HMAC secret for service gate tokens (private/shared access).
  // Stashed here so the plain-JS router (lib/service-router.mjs, loaded by
  // server.js outside the TS graph) can read it off globalThis.
  gateSecret?: string;
  restored?: boolean;
  exitHook?: boolean; // process-exit cleanup registered (once per process)
}

declare global {
  // eslint-disable-next-line no-var
  var __orchServices: Registry | undefined;
}

function reg(): Registry {
  if (!global.__orchServices) global.__orchServices = { services: new Map(), listeners: new Map() };
  return global.__orchServices;
}

const keyOf = (projectId: string, name: string) => `${projectId}:${name}`;

// ---------- public URLs ----------

// Public routing is on only when the feature flag is on, public hostnames are
// explicitly opted into (ORCH_SERVICE_HOSTS — the flag alone must never expose
// anything), AND the instance knows its own hostname; otherwise serviceUrl
// falls back to the honest local URL. A nonstandard port in PUBLIC_BASE_URL
// (local testing) is carried into the built URLs; hostname parsing ignores it
// (lib/service-host.mjs strips ports).
function publicBase(): { proto: string; host: string; portSuffix: string } | null {
  if (!resolveFeatures().services || !serviceHostsEnabled()) return null;
  const host = appHostFromEnv();
  if (!host) return null;
  try {
    const u = new URL(process.env.PUBLIC_BASE_URL!);
    return { proto: u.protocol.replace(/:$/, ""), host, portSuffix: u.port ? `:${u.port}` : "" };
  } catch {
    return null;
  }
}

/** The public hostname a persisted service is served on, or null (local dev / flag off). */
export function publicServiceHost(slug: string | null): string | null {
  const base = publicBase();
  return base && slug ? `${slug}--${base.host}` : null;
}

function publicServiceUrl(slug: string | null): string | null {
  const base = publicBase();
  return base && slug ? `${base.proto}://${slug}--${base.host}${base.portSuffix}` : null;
}

// The browseable URL for a service on the local host — the fallback when the
// instance has no public hostname (local dev) or the feature flag is off.
function serviceUrl(port: number): string {
  return `http://localhost:${port}`;
}

// ---------- persistence (write-through to the services table) ----------

interface ServiceRow {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  kind: string;
  command: string;
  port: number;
  managed: number;
  desired_state: "running" | "stopped";
  visibility: ServiceVisibility;
  share_token: string;
  pid: number; // process-group leader while running; 0 otherwise (orphan reaping)
}

function rowFor(projectId: string, name: string): ServiceRow | undefined {
  return getDb()
    .prepare("SELECT * FROM services WHERE project_id = ? AND name = ?")
    .get(projectId, name) as ServiceRow | undefined;
}

// Pull persisted identity into a freshly-created Managed entry so a service
// re-registered after a restart keeps its slug/visibility/share token.
function hydrate(m: Managed): Managed {
  const row = rowFor(m.projectId, m.name);
  if (row) {
    m.slug = row.slug;
    m.visibility = row.visibility;
    m.shareToken = row.share_token;
  }
  return m;
}

// Assign the public hostname label. Globally unique (the hostname carries no
// project): prefer the service name — except the ubiquitous "dev", which takes
// the project's name so the URL reads calc--ishan…, not dev--ishan…. On a
// clash, qualify with the project name, then a numeric suffix. Never reassigned
// once persisted, so URLs are stable for a service's whole life.
function assignSlug(m: Managed, project: Project): string {
  if (m.slug) return m.slug;
  const db = getDb();
  const taken = (s: string) =>
    !!db.prepare("SELECT 1 FROM services WHERE slug = ?").get(s);
  const base =
    slugifyServiceName(m.name === "dev" ? project.name : m.name) ||
    slugifyServiceName(project.name) ||
    "svc";
  let candidate = base;
  if (taken(candidate)) {
    const qualified = slugifyServiceName(`${project.name}-${m.name}`);
    if (qualified && !taken(qualified)) {
      candidate = qualified;
    } else {
      let i = 2;
      while (taken(`${base}-${i}`)) i++;
      candidate = `${base}-${i}`;
    }
  }
  m.slug = candidate;
  return candidate;
}

// Write the entry through to the services table (insert or update). The
// in-memory Managed map stays the runtime source of truth; rows carry what must
// survive a restart: identity (slug), sharing state, and — for managed dev
// servers — the intent to be running so boot can restore them.
function persist(m: Managed, project: Project, desired: "running" | "stopped"): void {
  const db = getDb();
  assignSlug(m, project);
  getGateSecret(); // any persisted service can be routed — the router needs the secret on globalThis
  const now = Date.now();
  const existing = rowFor(m.projectId, m.name);
  if (existing) {
    db.prepare(
      `UPDATE services SET slug = ?, kind = ?, command = ?, port = ?, managed = ?,
       desired_state = ?, visibility = ?, share_token = ?, updated_at = ? WHERE id = ?`
    ).run(
      m.slug, m.kind, m.command, m.port, m.managed ? 1 : 0,
      desired, m.visibility, m.shareToken, now, existing.id
    );
  } else {
    db.prepare(
      `INSERT INTO services (id, project_id, name, slug, kind, command, port, managed,
        desired_state, visibility, share_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      nanoid(), m.projectId, m.name, m.slug, m.kind, m.command, m.port,
      m.managed ? 1 : 0, desired, m.visibility, m.shareToken, now, now
    );
  }
}

function setDesired(projectId: string, name: string, desired: "running" | "stopped"): void {
  getDb()
    .prepare("UPDATE services SET desired_state = ?, updated_at = ? WHERE project_id = ? AND name = ?")
    .run(desired, Date.now(), projectId, name);
}

// Record the live process-group leader (0 = none). Written at spawn and cleared
// on exit, so a row with a nonzero pid after boot means the previous server
// died without stopping the service — restoreServices() reaps that group.
function setPid(projectId: string, name: string, pid: number): void {
  getDb()
    .prepare("UPDATE services SET pid = ? WHERE project_id = ? AND name = ?")
    .run(pid, projectId, name);
}

// ---------- gate secret ----------

// Instance-local secret signing the short-lived tokens that admit a browser to a
// private/shared service hostname (see lib/service-host.mjs). Minted and
// verified on this box alone, persisted so links survive restarts.
export function getGateSecret(): string {
  const r = reg();
  if (r.gateSecret) return r.gateSecret;
  let s = getSetting("service_gate_secret");
  if (!s) {
    s = crypto.randomBytes(32).toString("hex");
    setSetting("service_gate_secret", s);
  }
  r.gateSecret = s;
  return s;
}

// Which configured command a service name maps to, or null if the project has no
// command for it. Only these three names are orchestrator-managed; expose_service
// can register any other name as an (unmanaged) exposed entry.
function configuredCommand(project: Project, name: string): { kind: ServiceKind; command: string } | null {
  const map: Record<string, { kind: ServiceKind; command: string }> = {
    dev: { kind: "dev", command: project.dev_command },
    setup: { kind: "setup", command: project.setup_command },
    test: { kind: "test", command: project.test_command },
  };
  const hit = map[name];
  return hit && hit.command.trim() ? hit : null;
}

function shareUrlOf(m: Pick<Managed, "slug" | "visibility" | "shareToken">): string | null {
  if (m.visibility !== "shared" || !m.shareToken) return null;
  const url = publicServiceUrl(m.slug);
  return url ? `${url}/?t=${m.shareToken}` : null;
}

function toInfo(m: Managed): ServiceInfo {
  return {
    projectId: m.projectId,
    name: m.name,
    kind: m.kind,
    command: m.command,
    status: m.status,
    pid: m.proc?.pid ?? null,
    exitCode: m.exitCode,
    port: m.port,
    // Prefer the public hostname when routing is live; m.url keeps the honest
    // local fallback (and doubles as the "this service has a URL" flag).
    url: m.url ? publicServiceUrl(m.slug) ?? m.url : null,
    startedAt: m.startedAt,
    managed: m.managed,
    slug: m.slug,
    visibility: m.visibility,
    shareUrl: shareUrlOf(m),
    error: m.error,
  };
}

// ---------- pub/sub (per project) ----------

export function subscribeServices(projectId: string, fn: Listener): () => void {
  const r = reg();
  let set = r.listeners.get(projectId);
  if (!set) { set = new Set(); r.listeners.set(projectId, set); }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) r.listeners.delete(projectId);
  };
}

function emit(projectId: string, ev: ServiceEvent): void {
  const set = reg().listeners.get(projectId);
  if (!set) return;
  for (const fn of set) {
    try { fn(ev); } catch { /* one dead subscriber never breaks delivery */ }
  }
}

function pushStatus(m: Managed): void {
  emit(m.projectId, { type: "status", service: toInfo(m) });
}

// Append captured output, splitting on newlines and trimming the ring buffer.
function addLog(m: Managed, stream: ServiceLogLine["stream"], chunk: string): void {
  const parts = chunk.split(/\r?\n/);
  // A trailing "" from a chunk that ended with a newline isn't a real line.
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  for (const text of parts) {
    const line: ServiceLogLine = { ts: Date.now(), stream, text };
    m.logs.push(line);
    if (m.logs.length > LOG_CAP) m.logs.shift();
    emit(m.projectId, { type: "log", name: m.name, line });
  }
}

function newManaged(projectId: string, name: string, kind: ServiceKind, command: string, port: number, managed: boolean): Managed {
  return hydrate({
    projectId, name, kind, command, port,
    proc: null, status: "stopped", exitCode: null, url: null, startedAt: null, managed, error: null, logs: [],
    slug: null, visibility: "private", shareToken: "",
  });
}

// Extra env injected into every service process. PORT makes the bind address
// deterministic; the host-check vars pre-clear the frameworks that respect env
// for requests arriving via the public hostname (the router preserves the
// original Host header). Vite/Next need a config line instead — the public
// host is handed over as ORCH_PUBLIC_HOST so configs can reference it; see
// README "Managed services".
function serviceEnv(m: Managed): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(m.port), FORCE_COLOR: "1" };
  const host = publicServiceHost(m.slug);
  if (host) {
    env.ORCH_PUBLIC_HOST = host;
    env.DANGEROUSLY_DISABLE_HOST_CHECK = "true"; // CRA / webpack-dev-server
    env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = host; // Vite ≥ 5.4.12
  }
  return env;
}

// ---------- port availability ----------

// Can we bind the service's port right now? A dev server that can't bind just
// crash-loops with EADDRINUSE buried in its logs; probing first lets the
// supervisor surface a readable error instead. Loopback probe: catches anything
// bound to 127.0.0.1 or the wildcard (the common cases).
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

// Poll until the port frees up (a just-stopped predecessor winding down, a
// just-reaped orphan) or the deadline passes.
async function portBecameFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probePort(port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

// Resolves once the managed process has exited (or after timeoutMs — the
// SIGKILL escalation in killProcGroup fires at 4s, so callers wait a bit past
// that). Immediate when nothing is running.
function procExited(m: Managed, timeoutMs: number): Promise<void> {
  const proc = m.proc;
  if (!proc) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    t.unref?.();
    proc.once("exit", () => { clearTimeout(t); resolve(); });
  });
}

// ---------- lifecycle ----------

// Best-effort cleanup when THIS process exits cleanly (process.exit — e.g. Next
// dev's SIGINT handler, or server.js's fallback signal handler): SIGKILL every
// managed process group so an app restart never leaves zombie dev servers
// holding ports. Sync-only by contract ('exit' handlers can't await); rows keep
// desired_state='running', so boot restores the services. A kill -9 of the
// server skips this entirely — that's what the boot reaper in restoreServices()
// is for. Registered once per process (flag survives HMR with the registry).
function installExitHook(): void {
  const r = reg();
  if (r.exitHook) return;
  r.exitHook = true;
  process.on("exit", () => {
    for (const m of reg().services.values()) {
      if (m.managed && m.proc?.pid != null) {
        try { process.kill(-m.proc.pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  });
}

// Start (or no-op if already running) a configured service for a project. Spawns
// the command in the project's working dir with PORT injected, as its own process
// group (detached) so stop() can signal the whole tree (shell → npm → node).
// Async because a dev server's port is probed first (see probePort).
export async function startService(project: Project, name: string): Promise<ServiceInfo> {
  const cfg = configuredCommand(project, name);
  if (!cfg) throw new Error(`No "${name}" command configured for this project`);
  if (!project.repo_path) throw new Error("Set the project's working directory first");

  const r = reg();
  const k = keyOf(project.id, name);
  const existing = r.services.get(k);
  if (existing && (existing.status === "running" || existing.status === "starting")) {
    return toInfo(existing); // already up — idempotent
  }

  const m: Managed = existing ?? newManaged(project.id, name, cfg.kind, cfg.command, project.port, true);
  // Re-read config + port in case they changed since a prior run.
  m.kind = cfg.kind; m.command = cfg.command; m.port = project.port; m.managed = true;
  m.exitCode = null;
  m.error = null;
  m.status = "starting";
  m.startedAt = Date.now();
  // A long-running dev server gets a URL; one-shot setup/test commands don't.
  m.url = cfg.kind === "dev" ? serviceUrl(project.port) : null;
  r.services.set(k, m);
  // Persist intent BEFORE spawning so the slug (public hostname) exists for the
  // env we inject, and so a crash-before-exit still restores on next boot. Only
  // a dev server is meant to keep running; one-shots never auto-start.
  persist(m, project, cfg.kind === "dev" ? "running" : "stopped");
  pushStatus(m); // show "starting" while the port probe runs

  // Only the dev kind binds the port; one-shot setup/test commands don't.
  // The grace window absorbs a just-stopped predecessor (restart) or a
  // just-reaped orphan (boot) releasing the port.
  if (cfg.kind === "dev" && !(await portBecameFree(m.port, 2000))) {
    m.status = "errored";
    m.url = null;
    m.error =
      `Port ${m.port} is already in use by another process, so "${cfg.command}" was not started. ` +
      `Stop whatever is holding the port (lsof -i :${m.port}) or change the project's port, then start again.`;
    addLog(m, "system", m.error);
    pushStatus(m);
    return toInfo(m);
  }

  let proc: ChildProcess;
  try {
    proc = spawn(cfg.command, {
      cwd: project.repo_path,
      shell: true,
      detached: true, // own process group → stop() can kill the whole tree
      env: serviceEnv(m),
    });
  } catch (e) {
    m.status = "errored";
    m.proc = null;
    m.error = `Failed to start: ${(e as Error).message}`;
    addLog(m, "system", m.error);
    pushStatus(m);
    return toInfo(m);
  }

  m.proc = proc;
  m.status = "running";
  if (proc.pid != null) setPid(m.projectId, m.name, proc.pid); // for the boot orphan reaper
  installExitHook();
  addLog(m, "system", `$ ${cfg.command}  (PORT=${project.port}, pid ${proc.pid})`);
  pushStatus(m);

  proc.stdout?.on("data", (d: Buffer) => addLog(m, "stdout", d.toString()));
  proc.stderr?.on("data", (d: Buffer) => addLog(m, "stderr", d.toString()));
  proc.on("error", (err) => {
    m.status = "errored";
    m.error = `Process error: ${err.message}`;
    addLog(m, "system", m.error);
    pushStatus(m);
  });
  proc.on("exit", (code, signal) => {
    m.proc = null;
    m.exitCode = code;
    // A clean exit (one-shot finished, or stopped by us) reads as "exited";
    // a nonzero/crashed exit reads as "errored" so the status dot goes red.
    m.status = code === 0 || signal === "SIGTERM" || signal === "SIGKILL" ? "exited" : "errored";
    if (m.kind === "dev") m.url = null;
    setPid(m.projectId, m.name, 0); // nothing left to reap
    addLog(m, "system", signal ? `Stopped (signal ${signal})` : `Exited (code ${code})`);
    pushStatus(m);
  });

  return toInfo(m);
}

// SIGTERM a managed service's process group, then SIGKILL any survivor after a
// short grace period. Kill the whole group (negative pid) since shell:true wraps
// the real server (shell → npm → node). No-op for an entry we don't own.
function killProcGroup(m: Managed): void {
  const proc = m.proc;
  if (!proc || proc.pid == null) return;
  const pid = proc.pid;
  try { process.kill(-pid, "SIGTERM"); } catch { try { proc.kill("SIGTERM"); } catch { /* gone */ } }
  setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* already dead */ } }, 4000).unref?.();
}

// Signal a managed service's process group to stop. Returns the settled info.
// This is a PAUSE: the registry entry (and its persisted row) stay put so the
// service can be restarted at the same public URL. To fully retire a service —
// e.g. when its project is deleted — use removeProjectServices().
export function stopService(projectId: string, name: string): ServiceInfo | null {
  const m = reg().services.get(keyOf(projectId, name));
  if (!m) return null;
  // The user asked for stopped — record it so boot doesn't resurrect it. (A
  // crash mid-run leaves desired_state='running' on purpose.)
  setDesired(projectId, name, "stopped");
  if (m.proc && m.proc.pid != null) {
    killProcGroup(m);
  } else {
    m.status = "stopped";
    pushStatus(m);
  }
  return toInfo(m);
}

// Fully retire every service belonging to a project: kill each managed process
// group AND drop its in-memory registry entry so the public host-header router
// (lib/service-router.mjs) stops serving its <slug>--<host> URL immediately —
// findBySlug returns null → the branded 404, not a "stopped" 503. Called from
// the project DELETE handler, where the services table rows are cascade-removed
// alongside (getServices no longer sees them either). Unlike stopService, there
// is no coming back: the entry, the process, and the row are all gone.
export function removeProjectServices(projectId: string): void {
  const r = reg();
  for (const [k, m] of r.services) {
    if (m.projectId !== projectId) continue;
    killProcGroup(m);
    r.services.delete(k); // router's findBySlug now misses → 404 on the public URL
    emit(projectId, { type: "removed", name: m.name });
  }
}

export async function restartService(project: Project, name: string): Promise<ServiceInfo> {
  const m = reg().services.get(keyOf(project.id, name));
  stopService(project.id, name);
  // Wait for the old process group to actually die (SIGKILL escalation fires at
  // 4s) so the port is free — otherwise the new spawn would race its
  // predecessor and report a bogus port conflict.
  if (m) await procExited(m, 6000);
  return startService(project, name);
}

// Register (or update) a service Claude started inside a turn — the expose_service
// MCP tool. We don't own the process, so this entry is informational: it records
// the port/url so the UI can show it and Claude can report a working link. It IS
// persisted (never auto-started — the process dies with the server) so its
// public URL and visibility survive a restart for when it's re-registered.
export function exposeService(project: Project, name: string, port: number, url?: string): ServiceInfo {
  const r = reg();
  const k = keyOf(project.id, name);
  const cfg = configuredCommand(project, name);
  const m: Managed =
    r.services.get(k) ??
    newManaged(project.id, name, cfg?.kind ?? "exposed", cfg?.command ?? "", port, false);
  m.port = port;
  m.url = url?.trim() || serviceUrl(port);
  // Only flip to "running" for an entry we don't actively supervise; a managed
  // process keeps its real lifecycle status.
  if (!m.managed) m.status = "running";
  if (m.startedAt == null) m.startedAt = Date.now();
  r.services.set(k, m);
  persist(m, project, "stopped");
  addLog(m, "system", `Exposed on port ${port} → ${toInfo(m).url}`);
  pushStatus(m);
  return toInfo(m);
}

// ---------- sharing ----------

const VISIBILITIES: ServiceVisibility[] = ["private", "shared", "public"];

// Flip who may open the service's public URL. Applies on the next request — the
// router reads the live registry. Entering "shared" mints the token the link
// carries (kept when switching away so flipping back revives old links; rotate
// to cut them off).
export function setServiceVisibility(project: Project, name: string, visibility: ServiceVisibility): ServiceInfo {
  if (!VISIBILITIES.includes(visibility)) throw new Error(`Unknown visibility "${visibility}"`);
  const r = reg();
  const k = keyOf(project.id, name);
  let m = r.services.get(k);
  if (!m) {
    // Not running this process-lifetime — a configured command or a persisted
    // entry. Materialize it so the setting sticks and the router can see it.
    const cfg = configuredCommand(project, name);
    const row = rowFor(project.id, name);
    if (!cfg && !row) throw new Error(`Unknown service "${name}"`);
    m = newManaged(project.id, name, cfg?.kind ?? (row!.kind as ServiceKind), cfg?.command ?? row!.command,
      row?.port || project.port, cfg ? true : !!row!.managed);
    r.services.set(k, m);
  }
  m.visibility = visibility;
  if (visibility === "shared" && !m.shareToken) m.shareToken = nanoid(24);
  const row = rowFor(project.id, name);
  persist(m, project, row?.desired_state ?? "stopped");
  pushStatus(m);
  return toInfo(m);
}

// Mint a fresh share token — every previously-sent shared link stops working on
// the next request (existing browser cookies expire on their own short TTL).
export function rotateShareToken(project: Project, name: string): ServiceInfo {
  const m = reg().services.get(keyOf(project.id, name));
  if (!m) throw new Error(`Unknown service "${name}"`);
  m.shareToken = nanoid(24);
  const row = rowFor(project.id, name);
  persist(m, project, row?.desired_state ?? "stopped");
  pushStatus(m);
  return toInfo(m);
}

// ---------- boot restore + orphan reaping ----------

// Does pid still lead a live process group that looks like the service we
// spawned? Guards the reaper against pid reuse: after a crash the pid could
// have been recycled by an unrelated process, and killing that would be worse
// than leaving an orphan. `ps` membership check: some process in the group must
// still carry the service's command line (shell:true spawns `sh -c <command>`,
// and every descendant shares the group).
function groupLooksLikeService(pid: number, command: string): boolean {
  try { process.kill(-pid, 0); } catch { return false; } // group gone
  if (!command.trim()) return false;
  try {
    const out = execFileSync("ps", ["-A", "-o", "pgid=,command="], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      const t = line.trim();
      const sp = t.indexOf(" ");
      if (sp < 1 || Number(t.slice(0, sp)) !== pid) continue;
      if (t.slice(sp + 1).includes(command.trim())) return true;
    }
  } catch { /* no ps → refuse to kill on a guess */ }
  return false;
}

// Kill a process group orphaned by a dead server (kill -9, OOM, power loss) so
// the respawn doesn't fight its own predecessor for the port. SIGKILL, not
// SIGTERM: the owning server is gone, there is no graceful state to save, and
// the port must be free before startService probes it.
async function reapOrphan(row: ServiceRow): Promise<void> {
  if (!row.pid) return;
  if (groupLooksLikeService(row.pid, row.command)) {
    try { process.kill(-row.pid, "SIGKILL"); } catch { /* died in between */ }
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try { process.kill(-row.pid, 0); } catch { break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    console.log(`[services] reaped orphaned process group ${row.pid} (${row.name}) from a previous server`);
  }
  setPid(row.project_id, row.name, 0);
}

// Re-hydrate the registry from the services table — triggered at boot by
// server.js's loopback ping to /api/instance/services-restore, idempotent per
// process. First, any process group a dead server left behind is reaped (stale
// pid column). Then managed rows with desired_state='running' are actually
// started; everything else (stopped services, expose_service entries whose
// process died with the old server) is seeded stopped so its slug, visibility
// and share token stay attached to the same public URL.
export async function restoreServices(): Promise<void> {
  const r = reg();
  if (r.restored) return;
  r.restored = true;

  let rows: (ServiceRow & { desired_state: string })[];
  try {
    rows = getDb().prepare("SELECT * FROM services").all() as (ServiceRow & { desired_state: string })[];
  } catch {
    return; // fresh instance, nothing persisted yet
  }
  // Reap orphans even when the feature flag is off — a stale process group from
  // a crashed flag-on run must not survive the flag being flipped.
  for (const row of rows) {
    if (row.managed) await reapOrphan(row);
  }
  if (!resolveFeatures().services) return;
  getGateSecret(); // stash for the router (globalThis)

  for (const row of rows) {
    const project = getProject(row.project_id);
    if (!project) continue;
    const k = keyOf(row.project_id, row.name);
    if (r.services.has(k)) continue;
    if (row.managed && row.desired_state === "running" && configuredCommand(project, row.name)) {
      try {
        await startService(project, row.name);
      } catch (e) {
        console.warn(`[services] could not restore ${project.name}/${row.name}: ${(e as Error).message}`);
      }
      continue;
    }
    // Not restartable (expose_service entry, or the command was cleared): keep
    // the identity, mark it stale until something re-registers/starts it.
    const m = newManaged(row.project_id, row.name, row.kind as ServiceKind, row.command, row.port, !!row.managed);
    r.services.set(k, m);
    if (!row.managed) {
      setDesired(row.project_id, row.name, "stopped");
      addLog(m, "system", "Server restarted — stale until re-registered by a session.");
    }
  }
  const started = [...r.services.values()].filter((m) => m.status === "running").length;
  if (rows.length) console.log(`[services] restored ${rows.length} persisted service(s), ${started} started`);
}

// ---------- reads ----------

// The full service view for a project: every configured command (dev/setup/test
// with a non-empty command), reflecting its live process state when one exists,
// plus any extra registered entries (exposed, or a kind whose command was cleared
// while its process is still alive). Stable order: dev, setup, test, then extras.
export function listServices(project: Project): ServiceInfo[] {
  const r = reg();
  const out: ServiceInfo[] = [];
  const seen = new Set<string>();
  for (const name of ["dev", "setup", "test"] as const) {
    const cfg = configuredCommand(project, name);
    if (!cfg) continue;
    seen.add(name);
    const m = r.services.get(keyOf(project.id, name));
    if (m) {
      // Keep the displayed command/port fresh against the latest project config.
      m.command = cfg.command; m.port = project.port;
      out.push(toInfo(m));
    } else {
      // Never touched this process-lifetime; reflect any persisted identity.
      const row = rowFor(project.id, name);
      out.push({
        projectId: project.id, name, kind: cfg.kind, command: cfg.command,
        status: "stopped", pid: null, exitCode: null, port: project.port,
        url: cfg.kind === "dev" ? serviceUrl(project.port) : null, startedAt: null, managed: true,
        slug: row?.slug ?? null,
        visibility: row?.visibility ?? "private",
        shareUrl: row ? shareUrlOf({ slug: row.slug, visibility: row.visibility, shareToken: row.share_token }) : null,
        error: null,
      });
    }
  }
  // Extras: registered services that aren't a currently-configured kind.
  const extras: Managed[] = [];
  for (const m of r.services.values()) {
    if (m.projectId !== project.id || seen.has(m.name)) continue;
    extras.push(m);
  }
  extras.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  for (const m of extras) out.push(toInfo(m));
  return out;
}

// How many supervised processes are live right now — reported (informationally)
// by GET /api/instance/idle. Running services deliberately do NOT mark the
// instance busy: sleeping is safe because desired_state survives in the
// services table and boot restore relaunches them at the same public URL when
// the container wakes. A control plane that wants to keep a box warm while a
// user-visible service runs can apply its own policy on this count.
export function runningServiceCount(): number {
  let n = 0;
  for (const m of reg().services.values()) {
    if (m.managed && (m.status === "running" || m.status === "starting")) n++;
  }
  return n;
}

// The captured logs for a project's services (snapshot), keyed by service name.
export function serviceLogs(projectId: string): Record<string, ServiceLogLine[]> {
  const r = reg();
  const out: Record<string, ServiceLogLine[]> = {};
  for (const m of r.services.values()) {
    if (m.projectId === projectId) out[m.name] = m.logs;
  }
  return out;
}
