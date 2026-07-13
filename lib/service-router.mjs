/* Host-header router for public service hostnames (server.js).
 *
 * Requests for <slug>--<appHost> are dispatched here BEFORE Next.js ever sees
 * them: look the slug up in the live service registry (lib/services.ts keeps it
 * on globalThis, and server.js + Next share one process), enforce the service's
 * visibility, then reverse-proxy to 127.0.0.1:<port> — including WebSocket
 * upgrades, which Vite/Next HMR require. The app's own hostname and anything
 * unrecognized fall through to Next untouched.
 *
 * Auth model per service (services.visibility):
 *   public  — no auth.
 *   shared  — the tokened link (?t=<share_token>) or a gate cookie it set.
 *   private — a gate cookie only, acquired via /api/services/grant on the APP
 *             hostname (which sits behind the instance's normal session auth)
 *             redirecting back to <serviceHost>/__orch/auth?t=<short-lived token>.
 *
 * Plain ESM JS: loaded by server.js (raw Node, CommonJS) via dynamic import,
 * same pattern as lib/auth/origin.mjs. No TS imports — the registry is read
 * straight off globalThis.
 */
import http from "node:http";
import {
  appHostFromEnv,
  parseServiceHost,
  verifyGateToken,
  mintGateToken,
  parseCookieHeader,
  GATE_COOKIE,
} from "./service-host.mjs";

const COOKIE_TTL_MS = 12 * 60 * 60 * 1000; // gate cookie lifetime (12h)

const truthy = (v) => v === "1" || v === "true" || v === "on";

/** Is hostname routing live on this instance at all? (Cheap; read per request.) */
export function serviceRoutingEnabled() {
  return (
    truthy(process.env.ORCH_FEATURE_SERVICES) &&
    process.env.ORCH_CONTROL_PLANE !== "1" &&
    !!appHostFromEnv()
  );
}

function registry() {
  return globalThis.__orchServices || null;
}

function findBySlug(slug) {
  const r = registry();
  if (!r) return null;
  for (const m of r.services.values()) {
    if (m.slug === slug) return m;
  }
  return null;
}

function isHtmlRequest(req) {
  return String(req.headers.accept || "").includes("text/html");
}

function appOrigin() {
  return (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
}

// The apex the fleet lives under (ishan.getoperator.dev -> getoperator.dev),
// for the status-page footer.
function baseDomain() {
  const host = appHostFromEnv() || "";
  const parts = host.split(".");
  return parts.length > 2 ? parts.slice(1).join(".") : host;
}

// ---------- branded status / error page ----------

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function statusPage(res, code, name, message) {
  const app = appOrigin();
  const apex = baseDomain();
  res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} — not running</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#faf7f2;color:#2a2622}
  main{text-align:center;padding:48px;max-width:440px}
  h1{font-size:22px;margin:0 0 8px;letter-spacing:-.01em}
  p{margin:0 0 20px;color:#6b645c}
  a.btn{display:inline-block;padding:10px 18px;border-radius:10px;background:#c2603c;color:#fff;text-decoration:none;font-weight:600}
  footer{margin-top:40px;font-size:12px;color:#a39a8f}
  footer a{color:inherit}
  code{background:#f0eae1;padding:1px 6px;border-radius:6px}
</style></head><body><main>
  <h1><code>${esc(name)}</code> is not running</h1>
  <p>${esc(message)}</p>
  ${app ? `<a class="btn" href="${esc(app)}">Open your orchestrator</a>` : ""}
  <footer>hosted on ${esc(apex || "this instance")} — <a href="https://${esc(apex)}">report abuse</a></footer>
</main></body></html>
`);
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function redirect(res, location, setCookie) {
  const headers = { location, "cache-control": "no-store" };
  if (setCookie) headers["set-cookie"] = setCookie;
  res.writeHead(302, headers);
  res.end();
}

// ---------- auth ----------

function gateCookie(token, secure) {
  return (
    `${GATE_COOKIE}=${token}; Path=/; Max-Age=${Math.floor(COOKIE_TTL_MS / 1000)}; ` +
    `HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`
  );
}

function hasValidCookie(req, slug) {
  const secret = registry()?.gateSecret;
  if (!secret) return false;
  const token = parseCookieHeader(req.headers.cookie)[GATE_COOKIE];
  return !!token && verifyGateToken(secret, token, slug);
}

// Only ever redirect within this hostname — a tampered `next` must not become
// an open redirect.
function safeNextPath(raw) {
  const s = String(raw || "/");
  return s.startsWith("/") && !s.startsWith("//") ? s : "/";
}

function isSecureRequest(req) {
  return (appOrigin() || "").startsWith("https://") || req.headers["x-forwarded-proto"] === "https";
}

/**
 * Decide access for an authenticated-or-not request to a service host.
 * Returns { ok: true } to proxy, or { handled: true } when a response
 * (redirect / 401 / cookie handshake) was already written.
 */
function authorize(req, res, m, url) {
  if (m.visibility === "public") return { ok: true };
  const secure = isSecureRequest(req);
  const secret = registry()?.gateSecret;

  // Handshake target for BOTH flows: verify the short-lived token minted by
  // /api/services/grant (private) — set the cookie and land on `next`.
  if (url.pathname === "/__orch/auth") {
    const t = url.searchParams.get("t") || "";
    if (secret && verifyGateToken(secret, t, m.slug)) {
      const cookie = gateCookie(mintGateToken(secret, m.slug, COOKIE_TTL_MS), secure);
      redirect(res, safeNextPath(url.searchParams.get("next")), cookie);
    } else {
      statusPage(res, 403, m.name, "This sign-in link is invalid or expired. Open the service again from your orchestrator.");
    }
    return { handled: true };
  }

  // Shared link: ?t=<share_token> anywhere → set the gate cookie, then redirect
  // to the same URL with the token stripped so it isn't kept in the address bar.
  if (m.visibility === "shared") {
    const t = url.searchParams.get("t");
    if (t && m.shareToken && t === m.shareToken) {
      if (!secret) return { handled: (statusPage(res, 503, m.name, "This instance is still starting up — try again in a moment."), true) };
      url.searchParams.delete("t");
      const clean = url.pathname + (url.searchParams.size ? `?${url.searchParams}` : "");
      redirect(res, clean, gateCookie(mintGateToken(secret, m.slug, COOKIE_TTL_MS), secure));
      return { handled: true };
    }
  }

  if (hasValidCookie(req, m.slug)) return { ok: true };

  // Unauthenticated. Browsers get bounced through the app hostname, which sits
  // behind the instance's normal session auth and mints the handoff token.
  const app = appOrigin();
  if (isHtmlRequest(req) && app) {
    const next = encodeURIComponent(safeNextPath(req.url));
    redirect(res, `${app}/api/services/grant?slug=${encodeURIComponent(m.slug)}&next=${next}`);
  } else {
    json(res, 401, { error: "authentication required", service: m.name });
  }
  return { handled: true };
}

// ---------- proxying ----------

function forwardHeaders(req) {
  const headers = { ...req.headers };
  const remote = req.socket?.remoteAddress || "";
  headers["x-forwarded-for"] = headers["x-forwarded-for"]
    ? `${headers["x-forwarded-for"]}, ${remote}`
    : remote;
  headers["x-forwarded-proto"] = isSecureRequest(req) ? "https" : "http";
  headers["x-forwarded-host"] = req.headers.host || "";
  return headers;
}

function proxyHttp(req, res, m) {
  const upstream = http.request(
    { host: "127.0.0.1", port: m.port, method: req.method, path: req.url, headers: forwardHeaders(req) },
    (ur) => {
      res.writeHead(ur.statusCode || 502, ur.headers);
      ur.pipe(res);
    }
  );
  upstream.on("error", () => {
    if (!res.headersSent) {
      statusPage(res, 502, m.name, `The service is registered on port ${m.port} but nothing answered there. It may still be starting, or it crashed — check its logs in the Services panel.`);
    } else {
      try { res.destroy(); } catch { /* already gone */ }
    }
  });
  req.pipe(upstream);
}

function proxyUpgrade(req, socket, head, m) {
  if (head && head.length) socket.unshift(head);
  const upstream = http.request({
    host: "127.0.0.1",
    port: m.port,
    method: req.method,
    path: req.url,
    headers: forwardHeaders(req),
  });
  upstream.on("upgrade", (ur, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${ur.statusCode} ${ur.statusMessage}`];
    for (const [k, v] of Object.entries(ur.headers)) {
      if (Array.isArray(v)) v.forEach((vv) => lines.push(`${k}: ${vv}`));
      else lines.push(`${k}: ${v}`);
    }
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (upHead && upHead.length) upSocket.unshift(upHead);
    upSocket.on("error", () => socket.destroy());
    socket.on("error", () => upSocket.destroy());
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  // The upstream answered with a plain response (no upgrade) or refused — the
  // WS client only understands a dead socket.
  upstream.on("response", () => { try { socket.destroy(); } catch { /* gone */ } });
  upstream.on("error", () => { try { socket.destroy(); } catch { /* gone */ } });
  socket.on("error", () => { try { upstream.destroy(); } catch { /* gone */ } });
  upstream.end();
}

// ---------- entry points (called from server.js) ----------

function resolve(req) {
  const parsed = parseServiceHost(req.headers.host, appHostFromEnv());
  if (parsed.type === "app" || parsed.type === "other") return null;
  return parsed;
}

const isLive = (m) => m && (m.status === "running" || m.status === "starting");

/**
 * Handle an HTTP request if its Host names a service. Returns true when the
 * request was handled (proxied or answered); false → hand it to Next.
 */
export function handleServiceRequest(req, res) {
  if (!serviceRoutingEnabled()) return false;
  const parsed = resolve(req);
  if (!parsed) return false;

  const name = parsed.name;
  if (parsed.type === "invalid") {
    statusPage(res, 404, name, "No service by this name is registered on this instance.");
    return true;
  }
  const m = findBySlug(name);
  if (!m) {
    statusPage(res, 404, name, "No service by this name is registered on this instance. Start it from your orchestrator's Services panel.");
    return true;
  }
  const url = new URL(req.url || "/", "http://x");
  if (!isLive(m)) {
    statusPage(res, 503, m.name, "The service is registered but not running right now. Start it from your orchestrator, then reload.");
    return true;
  }
  const gate = authorize(req, res, m, url);
  if (gate.handled) return true;
  proxyHttp(req, res, m);
  return true;
}

/**
 * Handle a WebSocket upgrade if its Host names a service (Vite/Next HMR).
 * Returns true when handled; false → the caller's normal upgrade path.
 */
export function handleServiceUpgrade(req, socket, head) {
  if (!serviceRoutingEnabled()) return false;
  const parsed = resolve(req);
  if (!parsed) return false;

  const m = parsed.type === "service" ? findBySlug(parsed.name) : null;
  const refuse = (code, text) => {
    try { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); } catch { /* gone */ }
    socket.destroy();
  };
  if (!isLive(m)) return refuse(404, "Not Found"), true;
  // Same visibility gate as HTTP: the browser sends the host-scoped gate cookie
  // on same-origin WebSocket handshakes.
  if (m.visibility !== "public" && !hasValidCookie(req, m.slug)) {
    return refuse(403, "Forbidden"), true;
  }
  proxyUpgrade(req, socket, head, m);
  return true;
}
