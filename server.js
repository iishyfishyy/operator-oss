/* Orchestrator — custom Next.js server.
 *
 * Why this exists: the integrated terminal is a WebSocket to the node-pty
 * sidecar (pty-server.js, bound to 127.0.0.1). Behind a Cloudflare Tunnel only
 * ONE hostname/origin is exposed, so the browser cannot reach a second port.
 * This server fronts Next.js on a single port and proxies WebSocket upgrades on
 * `/pty` to the local sidecar — so one origin carries both the app and the
 * terminal, and the terminal works from a remote device over https/wss.
 *
 * HMR/Fast-Refresh upgrades (dev) are forwarded to Next via getUpgradeHandler();
 * everything else on the socket layer is the /pty proxy.
 *
 * `next({ dev })` uses Turbopack by default, matching the old `next dev
 * --turbopack` behaviour. server.js itself is plain Node (not bundled), so keep
 * it CommonJS and compatible with the running Node version.
 */
const http = require("node:http");
const nextImport = require("next");

// Last-resort process guards. Turns run detached (lib/runner.ts), owned by this
// process and not awaited by any request — so a stray rejection or throw from a
// background turn would, under Node's default policy, terminate the server and
// take down EVERY other tenant's in-flight turn plus all terminal/SSE sockets.
// (The concrete trigger we hardened for: deleting a project mid-turn leaves the
// runner writing to now-deleted task rows, hitting FOREIGN KEY errors.) The
// individual call sites are fixed to degrade gracefully; these are the backstop
// for the whole class. We log LOUDLY rather than exit — a single bad turn must
// not be able to kill the shared process. This can mask real bugs, so the noise
// is deliberate: every occurrence is a bug to chase, not a state to live in.
process.on("unhandledRejection", (reason) => {
  console.error("[server] UNHANDLED REJECTION (kept alive — investigate):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[server] UNCAUGHT EXCEPTION (kept alive — investigate):", err);
});

// Origin auth enforcement (lib/auth/origin.mjs selects the provider: open local
// mode by default, or Cloudflare Access when configured). middleware.ts
// covers the HTTP routes; WebSocket upgrades never reach Next middleware, so
// THIS file is the auth boundary for the terminal — an unverified /pty upgrade
// would hand out a shell. jose v6 is ESM-only, hence the dynamic import from
// this CommonJS file.
const cfAccessImport = import("./lib/auth/origin.mjs");

// Host-header router for public service hostnames (<slug>--<appHost>, e.g.
// calc--myhost.example.com). Behind ORCH_FEATURE_SERVICES; no-ops entirely
// (returns false, requests fall through to Next) when the flag or
// PUBLIC_BASE_URL is unset. Service hostnames carry their OWN per-service auth
// (visibility: private/shared/public — see lib/service-router.mjs), so they
// bypass the app-session origin gate below on purpose.
const serviceRouterImport = import("./lib/service-router.mjs");

// Per-instance overrides (see README "Configuration"). PTY_HOST/PTY_PORT must
// match what pty-server.js binds — the sidecar is loopback-only by default and
// is reached exclusively through this proxy.
const dev = process.env.NODE_ENV !== "production";
const port = process.env.PORT ? Number(process.env.PORT) : 3000;
const hostname = process.env.HOSTNAME || "0.0.0.0";
const ptyHost = process.env.PTY_HOST || "127.0.0.1";
const ptyPort = process.env.PTY_PORT ? Number(process.env.PTY_PORT) : 3001;

const next = typeof nextImport === "function" ? nextImport : nextImport.default;
const app = next({ dev });
const handle = app.getRequestHandler();

// Idleness signals for GET /api/instance/idle. Next's route handlers run in
// this same process, so a shared globalThis object is enough — lib/idle.ts
// owns the shape and the SSE counter; this file stamps requests and counts
// live /pty sockets. Keep the field names in sync with lib/idle.ts.
const bootAt = Date.now();
const activity = (globalThis.__orchActivity ??= {
  startedAt: bootAt,
  lastRequestAt: bootAt,
  openPty: 0,
  openSse: 0,
});
// Health/metadata probes (idle, version, usage) never count as user activity —
// otherwise a monitor's own loopback polling would keep an idle box perpetually
// awake and defeat an idle-stop daemon. Mirrors the service-token path list in
// middleware.ts.
const countsAsActivity = (url) => {
  const p = String(url || "").split("?")[0];
  return (
    p !== "/api/instance/idle" &&
    p !== "/api/instance/usage" &&
    p !== "/api/version" &&
    p !== "/api/instance/services-restore"
  );
};

// Restore the persisted service registry (lib/services.ts) as soon as the
// server is up: managed dev servers with desired_state='running' restart with
// the box, keeping their public <slug>--<host> URLs live without anyone opening
// the app. Done via a loopback self-ping (the route runs inside Next's module
// graph, which this plain-Node file can't import); the service token clears the
// origin gate the same way the health probes do. Retries paper over Next's
// route compilation on a cold dev boot.
function restorePersistedServices() {
  const url = `http://127.0.0.1:${port}/api/instance/services-restore`;
  const headers = process.env.SERVICE_TOKEN
    ? { "x-service-token": process.env.SERVICE_TOKEN }
    : {};
  let attempts = 0;
  const ping = () => {
    attempts++;
    fetch(url, { method: "POST", headers })
      .then((res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
      })
      .catch((err) => {
        if (attempts < 5) setTimeout(ping, 3000).unref?.();
        else console.warn(`[services] boot restore ping failed: ${err?.message || err}`);
      });
  };
  ping();
}

// Forward a WebSocket upgrade on /pty to the node-pty sidecar. The sidecar reads
// cwd/cols/rows from the query string, so strip only the `/pty` prefix and keep
// the rest of the path + query intact.
function proxyPtyUpgrade(req, socket, head) {
  const rest = req.url.slice("/pty".length);
  const upstreamPath = rest.startsWith("/") ? rest : "/" + rest; // "" -> "/", "?q" -> "/?q"

  // Push any bytes already read with the upgrade back onto the client socket so
  // they get piped upstream (canonical reverse-proxy handshake).
  if (head && head.length) socket.unshift(head);

  const proxyReq = http.request({
    host: ptyHost,
    port: ptyPort,
    method: req.method,
    path: upstreamPath,
    headers: req.headers,
  });

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    // Count the live terminal connection (idleness signal); both sockets close
    // together, so guard against double-decrement.
    activity.openPty++;
    let counted = true;
    const dropCount = () => {
      if (!counted) return;
      counted = false;
      activity.openPty = Math.max(0, activity.openPty - 1);
    };
    socket.on("close", dropCount);
    proxySocket.on("close", dropCount);

    const lines = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}`];
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (Array.isArray(v)) v.forEach((vv) => lines.push(`${k}: ${vv}`));
      else lines.push(`${k}: ${v}`);
    }
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);

    proxySocket.on("error", () => socket.destroy());
    socket.on("error", () => proxySocket.destroy());
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxyReq.on("error", () => { try { socket.destroy(); } catch {} });
  socket.on("error", () => { try { proxyReq.destroy(); } catch {} });
  proxyReq.end();
}

Promise.all([app.prepare(), cfAccessImport, serviceRouterImport]).then(([, cfAccess, serviceRouter]) => {
  // getUpgradeHandler() is only valid after prepare().
  const upgradeHandler = app.getUpgradeHandler();
  const server = http.createServer((req, res) => {
    if (countsAsActivity(req.url)) activity.lastRequestAt = Date.now();
    // Service hostnames never reach Next: the router proxies (or answers with
    // its branded status page) and enforces the service's own visibility.
    if (serviceRouter.handleServiceRequest(req, res)) return;
    handle(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    activity.lastRequestAt = Date.now();
    // Service-host WebSocket upgrades (Vite/Next HMR inside a proxied preview)
    // are authenticated per service by the router, not by the app-session gate.
    if (serviceRouter.handleServiceUpgrade(req, socket, head)) return;
    let pathname = "/";
    try { pathname = new URL(req.url, "http://localhost").pathname; } catch {}
    const route = () => {
      if (pathname === "/pty" || pathname.startsWith("/pty/")) {
        proxyPtyUpgrade(req, socket, head);
      } else {
        // Next dev HMR / Fast Refresh websocket (dev runs with Access off; in
        // production /pty is the only upgrade, so gating ALL upgrades is safe).
        upgradeHandler(req, socket, head);
      }
    };
    if (!cfAccess.originAuthEnabled()) return route();
    cfAccess
      .verifyOriginNodeRequest(req)
      .then(route)
      .catch(() => {
        try { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); } catch {}
        socket.destroy();
      });
  });

  server.listen(port, hostname, () => {
    restorePersistedServices();
    const auth = cfAccess.originAuthEnabled()
      ? `origin auth ON — Cloudflare Access (team ${process.env.CF_ACCESS_TEAM_DOMAIN})`
      : "origin auth OFF — set CF_ACCESS_*" +
        (dev ? " (fine for local dev)" : "; DO NOT expose this origin unauthenticated");
    console.log(
      `[server] orchestrator ready on http://${hostname}:${port} ` +
        `(${dev ? "dev" : "production"}); /pty -> ws://${ptyHost}:${ptyPort}; ${auth}`,
    );
  });
});
