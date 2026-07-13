import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appHostFromEnv,
  parseServiceHost,
  isValidServiceSlug,
  slugifyServiceName,
  mintGateToken,
  verifyGateToken,
  GATE_COOKIE,
} from "../lib/service-host.mjs";
import { createProject, updateProject } from "../lib/store";
import {
  exposeService,
  startService,
  stopService,
  restoreServices,
  setServiceVisibility,
  rotateShareToken,
  listServices,
  getGateSecret,
  removeProjectServices,
} from "../lib/services";
import {
  handleServiceRequest,
  serviceRoutingEnabled,
} from "../lib/service-router.mjs";

const APP_HOST = "ishan.getoperator.dev";

// The registry lives on globalThis (survives HMR by design); tests reset it to
// simulate a server restart without recycling the process.
type Reg = { services: Map<string, unknown>; listeners: Map<string, unknown>; restored?: boolean; gateSecret?: string };
const registry = () => (globalThis as unknown as { __orchServices?: Reg }).__orchServices;
function wipeRegistry() {
  (globalThis as unknown as { __orchServices?: Reg }).__orchServices = undefined;
}

function withPublicHost() {
  process.env.PUBLIC_BASE_URL = `https://${APP_HOST}`;
  process.env.ORCH_FEATURE_SERVICES = "1";
}

beforeEach(() => {
  wipeRegistry();
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.ORCH_FEATURE_SERVICES;
});
afterEach(() => {
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.ORCH_FEATURE_SERVICES;
});

// ---------- hostname parsing ----------

describe("service hostname parsing", () => {
  it("classifies the app host, service hosts, and strangers", () => {
    expect(parseServiceHost(APP_HOST, APP_HOST)).toEqual({ type: "app" });
    expect(parseServiceHost(`${APP_HOST}:3000`, APP_HOST)).toEqual({ type: "app" });
    expect(parseServiceHost(`calc--${APP_HOST}`, APP_HOST)).toEqual({ type: "service", name: "calc" });
    expect(parseServiceHost(`CALC--${APP_HOST}:443`, APP_HOST)).toEqual({ type: "service", name: "calc" });
    expect(parseServiceHost("localhost:3000", APP_HOST)).toEqual({ type: "other" });
    expect(parseServiceHost("evil.example.com", APP_HOST)).toEqual({ type: "other" });
    // Another tenant's service host is not ours.
    expect(parseServiceHost("calc--maya.getoperator.dev", APP_HOST)).toEqual({ type: "other" });
    expect(parseServiceHost("", APP_HOST)).toEqual({ type: "other" });
    expect(parseServiceHost(undefined, APP_HOST)).toEqual({ type: "other" });
    // No app host configured (local dev) -> routing never claims anything.
    expect(parseServiceHost(`calc--${APP_HOST}`, null)).toEqual({ type: "other" });
  });

  it('rejects "--" runs and other illegal slugs as invalid, not misparsed', () => {
    // a--b--<host> must NOT resolve to service "a" of some other tenant.
    expect(parseServiceHost(`a--b--${APP_HOST}`, APP_HOST)).toEqual({ type: "invalid", name: "a--b" });
    expect(parseServiceHost(`---${APP_HOST}`, APP_HOST)).toEqual({ type: "invalid", name: "-" });
    expect(parseServiceHost(`-x--${APP_HOST}`, APP_HOST)).toEqual({ type: "invalid", name: "-x" });
  });

  it("validates and slugifies service names", () => {
    expect(isValidServiceSlug("calc")).toBe(true);
    expect(isValidServiceSlug("my-app-2")).toBe(true);
    expect(isValidServiceSlug("a--b")).toBe(false);
    expect(isValidServiceSlug("-a")).toBe(false);
    expect(isValidServiceSlug("A")).toBe(false);
    expect(isValidServiceSlug("")).toBe(false);
    expect(slugifyServiceName("My Cool App!")).toBe("my-cool-app");
    expect(slugifyServiceName("a--b")).toBe("a-b"); // separator can never survive
    expect(slugifyServiceName("--weird--")).toBe("weird");
    expect(slugifyServiceName("???")).toBe("");
  });

  it("derives the app host from PUBLIC_BASE_URL", () => {
    expect(appHostFromEnv({ PUBLIC_BASE_URL: `https://${APP_HOST}` })).toBe(APP_HOST);
    expect(appHostFromEnv({ PUBLIC_BASE_URL: "" })).toBe(null);
    expect(appHostFromEnv({ PUBLIC_BASE_URL: "not a url" })).toBe(null);
  });
});

// ---------- gate tokens ----------

describe("gate tokens", () => {
  const secret = "s3cret";
  it("round-trips, expires, and binds to the slug", () => {
    const t = mintGateToken(secret, "calc", 60_000, 1_000_000);
    expect(verifyGateToken(secret, t, "calc", 1_000_001)).toBe(true);
    expect(verifyGateToken(secret, t, "calc", 1_061_001)).toBe(false); // expired
    expect(verifyGateToken(secret, t, "other", 1_000_001)).toBe(false); // wrong service
    expect(verifyGateToken("wrong", t, "calc", 1_000_001)).toBe(false); // wrong secret
    expect(verifyGateToken(secret, t + "x", "calc", 1_000_001)).toBe(false); // tampered
    expect(verifyGateToken(secret, "garbage", "calc", 1_000_001)).toBe(false);
  });
});

// ---------- registry persistence / restore ----------

describe("service registry persistence", () => {
  it("persists an exposed service and restores it stopped (stale) after a restart", () => {
    withPublicHost();
    const project = createProject({ name: "Calc" });
    const info = exposeService(project, "calc", 5173);
    expect(info.slug).toBe("calc");
    expect(info.url).toBe(`https://calc--${APP_HOST}`);
    expect(info.visibility).toBe("private");

    // "Restart": the in-memory registry dies with the process; rows do not.
    wipeRegistry();
    restoreServices();
    const after = listServices(project).find((s) => s.name === "calc");
    expect(after).toBeDefined();
    expect(after!.status).toBe("stopped"); // we don't own the process — never auto-started
    expect(after!.slug).toBe("calc"); // identity survived: same URL when re-registered
    const again = exposeService(project, "calc", 5173);
    expect(again.slug).toBe("calc");
    expect(again.url).toBe(`https://calc--${APP_HOST}`);
  });

  it("auto-restarts a managed dev service whose desired_state is running", async () => {
    withPublicHost();
    const repo = (await import("./helpers")).tmpDir("svc-");
    const project = updateProject(createProject({ name: "Web App" }).id, {
      repo_path: repo,
      dev_command: "sleep 30",
    })!;
    const started = startService(project, "dev");
    expect(started.status).toBe("running");
    expect(started.slug).toBe("web-app"); // "dev" takes the project's name publicly
    expect(started.url).toBe(`https://web-app--${APP_HOST}`);

    wipeRegistry();
    restoreServices();
    const restored = listServices(project).find((s) => s.name === "dev");
    expect(restored!.status).toBe("running");
    expect(restored!.slug).toBe("web-app");
    stopService(project.id, "dev");

    // A user-stopped service stays stopped across the next restart.
    wipeRegistry();
    restoreServices();
    const stopped = listServices(project).find((s) => s.name === "dev");
    expect(stopped!.status).toBe("stopped");
  });

  it("keeps slugs globally unique across projects", () => {
    withPublicHost();
    const a = createProject({ name: "Alpha" });
    const b = createProject({ name: "Beta" });
    const first = exposeService(a, "api", 4001);
    const second = exposeService(b, "api", 4002);
    expect(first.slug).toBe("api");
    expect(second.slug).not.toBe("api");
    expect(second.slug).toContain("api");
    expect(second.slug!.includes("--")).toBe(false);
  });

  it("mints and rotates share tokens with the shared visibility", () => {
    withPublicHost();
    const project = createProject({ name: "Share Me" });
    exposeService(project, "demo", 4100);
    const shared = setServiceVisibility(project, "demo", "shared");
    expect(shared.visibility).toBe("shared");
    expect(shared.shareUrl).toMatch(new RegExp(`^https://demo--${APP_HOST}/\\?t=`));
    const rotated = rotateShareToken(project, "demo");
    expect(rotated.shareUrl).not.toBe(shared.shareUrl);

    // Visibility survives a restart.
    wipeRegistry();
    restoreServices();
    const after = listServices(project).find((s) => s.name === "demo");
    expect(after!.visibility).toBe("shared");
    expect(after!.shareUrl).toBe(rotated.shareUrl);
  });
});

// ---------- router dispatch + auth ----------

// Run the real router behind a real HTTP server (the same call shape server.js
// uses), with a tiny upstream standing in for a dev server.
describe("host-header router", () => {
  let upstream: http.Server;
  let upstreamPort: number;
  let front: http.Server;
  let frontPort: number;
  let fellThrough: boolean;

  beforeEach(async () => {
    wipeRegistry();
    withPublicHost();
    fellThrough = false;
    upstream = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`upstream saw host=${req.headers.host} path=${req.url}`);
    });
    front = http.createServer((req, res) => {
      if (handleServiceRequest(req, res)) return;
      fellThrough = true; // Next's territory
      res.writeHead(200).end("next-app");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
    upstreamPort = (upstream.address() as AddressInfo).port;
    frontPort = (front.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise((r) => front.close(r));
    await new Promise((r) => upstream.close(r));
  });

  function request(host: string, path = "/", headers: Record<string, string> = {}) {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: frontPort, path, headers: { host, ...headers } },
        (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        }
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("is inert without the feature flag / public host", () => {
    delete process.env.ORCH_FEATURE_SERVICES;
    expect(serviceRoutingEnabled()).toBe(false);
    process.env.ORCH_FEATURE_SERVICES = "1";
    delete process.env.PUBLIC_BASE_URL;
    expect(serviceRoutingEnabled()).toBe(false);
  });

  it("passes the app host and unknown hosts through to Next", async () => {
    const res = await request(APP_HOST, "/api/anything");
    expect(res.body).toBe("next-app");
    expect(fellThrough).toBe(true);
  });

  it("proxies a running public service, preserving Host and adding X-Forwarded-*", async () => {
    const project = createProject({ name: "Pub" });
    exposeService(project, "pub", upstreamPort);
    setServiceVisibility(project, "pub", "public");
    const res = await request(`pub--${APP_HOST}`, "/hello?x=1");
    expect(res.status).toBe(200);
    expect(res.body).toContain(`host=pub--${APP_HOST}`);
    expect(res.body).toContain("path=/hello?x=1");
  });

  it("removeProjectServices retires the entry so the public URL 404s (project delete)", async () => {
    const project = createProject({ name: "Doomed" });
    exposeService(project, "doomed", upstreamPort);
    setServiceVisibility(project, "doomed", "public");
    // Live: the URL proxies to the upstream.
    const live = await request(`doomed--${APP_HOST}`, "/");
    expect(live.status).toBe(200);

    // Simulate the project DELETE teardown (removeProjectServices runs before the
    // services rows are cascade-dropped).
    removeProjectServices(project.id);

    // Registry entry gone → the router misses the slug → branded 404, not a 503.
    const after = await request(`doomed--${APP_HOST}`, "/");
    expect(after.status).toBe(404);
    expect(after.body).toContain("not running");
    // And it's no longer visible in the project's service list.
    expect(listServices(project).some((s) => s.name === "doomed")).toBe(false);
  });

  it("serves the branded status page for unknown, invalid, and stopped services", async () => {
    const unknown = await request(`nosuch--${APP_HOST}`, "/");
    expect(unknown.status).toBe(404);
    expect(unknown.body).toContain("not running");
    expect(unknown.body).toContain("report abuse");

    const invalid = await request(`a--b--${APP_HOST}`, "/");
    expect(invalid.status).toBe(404);

    const project = createProject({ name: "Down" });
    exposeService(project, "down", upstreamPort);
    setServiceVisibility(project, "down", "public");
    wipeRegistry();
    restoreServices(); // exposed entry comes back stale/stopped
    const stopped = await request(`down--${APP_HOST}`, "/");
    expect(stopped.status).toBe(503);
    expect(stopped.body).toContain("not running right now");
  });

  it("answers 502 with the branded page when the proxied port is dead", async () => {
    const project = createProject({ name: "Dead" });
    const dead = http.createServer(() => {});
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise((r) => dead.close(r));
    exposeService(project, "dead", deadPort);
    setServiceVisibility(project, "dead", "public");
    const res = await request(`dead--${APP_HOST}`, "/");
    expect(res.status).toBe(502);
    expect(res.body).toContain("nothing answered");
  });

  it("private: redirects a browser to the app's grant endpoint, 401s non-HTML", async () => {
    const project = createProject({ name: "Priv" });
    exposeService(project, "priv", upstreamPort); // default private
    const browser = await request(`priv--${APP_HOST}`, "/page", { accept: "text/html" });
    expect(browser.status).toBe(302);
    expect(browser.headers.location).toBe(
      `https://${APP_HOST}/api/services/grant?slug=priv&next=${encodeURIComponent("/page")}`
    );
    const api = await request(`priv--${APP_HOST}`, "/api", { accept: "application/json" });
    expect(api.status).toBe(401);
  });

  it("private: a valid gate cookie admits; /__orch/auth sets it from a grant token", async () => {
    const project = createProject({ name: "Priv2" });
    exposeService(project, "priv2", upstreamPort);
    const secret = getGateSecret();

    // The hop from /api/services/grant: token -> cookie -> redirect to next.
    const hop = mintGateToken(secret, "priv2", 60_000);
    const auth = await request(`priv2--${APP_HOST}`, `/__orch/auth?t=${encodeURIComponent(hop)}&next=%2Fafter`);
    expect(auth.status).toBe(302);
    expect(auth.headers.location).toBe("/after");
    const cookie = String(auth.headers["set-cookie"]?.[0]);
    expect(cookie).toContain(`${GATE_COOKIE}=`);
    const token = cookie.split(";")[0].split("=").slice(1).join("=");

    const ok = await request(`priv2--${APP_HOST}`, "/in", { cookie: `${GATE_COOKIE}=${token}` });
    expect(ok.status).toBe(200);
    expect(ok.body).toContain("path=/in");

    // A cookie for a DIFFERENT service does not admit here.
    const foreign = mintGateToken(secret, "priv", 60_000);
    const no = await request(`priv2--${APP_HOST}`, "/in", { cookie: `${GATE_COOKIE}=${foreign}`, accept: "application/json" });
    expect(no.status).toBe(401);
  });

  it("shared: the tokened link sets a cookie and redirects clean; wrong token doesn't", async () => {
    const project = createProject({ name: "Shr" });
    exposeService(project, "shr", upstreamPort);
    const info = setServiceVisibility(project, "shr", "shared");
    const t = new URL(info.shareUrl!).searchParams.get("t")!;

    const hit = await request(`shr--${APP_HOST}`, `/demo?a=1&t=${t}`);
    expect(hit.status).toBe(302);
    expect(hit.headers.location).toBe("/demo?a=1");
    const cookie = String(hit.headers["set-cookie"]?.[0]).split(";")[0];
    const follow = await request(`shr--${APP_HOST}`, "/demo?a=1", { cookie });
    expect(follow.status).toBe(200);

    const bad = await request(`shr--${APP_HOST}`, "/demo?t=wrong", { accept: "application/json" });
    expect(bad.status).toBe(401);
  });

  it("public -> private takes effect on the next request", async () => {
    const project = createProject({ name: "Flip" });
    exposeService(project, "flip", upstreamPort);
    setServiceVisibility(project, "flip", "public");
    expect((await request(`flip--${APP_HOST}`, "/")).status).toBe(200);
    setServiceVisibility(project, "flip", "private");
    expect((await request(`flip--${APP_HOST}`, "/", { accept: "application/json" })).status).toBe(401);
  });
});
