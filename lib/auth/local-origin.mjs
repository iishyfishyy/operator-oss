/* Browser boundary rules. BOTH auth modes need one — they just need different
 * ones, and keeping the difference straight is what this file is for.
 *
 * Local mode deliberately has no login, so its boundary is the whole gate:
 * WebSockets are not protected by the same-origin policy, and DNS rebinding can
 * make an attacker's hostname resolve to 127.0.0.1. Since /pty grants a full
 * shell, accepting every Host/Origin pair in "open" mode is not safe. Hence
 * `localHttpRequestAllowed` / `localWebSocketRequestAllowed`, which pin the
 * TARGET to a known-good host:
 *   - localhost / *.localhost / 127.0.0.1 / ::1 are allowed on any port;
 *   - PUBLIC_BASE_URL is allowed exactly when configured;
 *   - ORCH_ALLOWED_ORIGINS adds comma-separated, exact http(s) origins for
 *     intentional LAN/reverse-proxy access.
 *
 * Cloudflare Access mode authenticates every request with a signed JWT, so that
 * target-host allowlist is neither necessary (rebinding an attacker hostname to
 * the origin produces a request with no valid assertion) nor knowable (the
 * tunnel hostname is whatever the operator configured, and PUBLIC_BASE_URL is
 * documented as optional). But identity is NOT the same property as intent. The
 * `CF_Authorization` cookie is `SameSite=None` by default, so a hostile page can
 * make a logged-in user's browser issue a request to the instance and the edge
 * will stamp a perfectly valid assertion onto it. The response is opaque to the
 * attacker, but the side effect already happened. That is ordinary CSRF, and a
 * JWT-only gate does not stop it — hence `sameOriginHttpRequestAllowed`.
 *
 * It is tempting to argue that CORS already covers the HTTP half: the API reads
 * `req.json()`, and a cross-site `fetch` with `content-type: application/json`
 * preflights, which the app answers with no CORS headers. That argument is
 * WRONG, twice over, and both halves were verified against Node's undici rather
 * than reasoned about:
 *   1. `Request.json()` does not look at Content-Type — it just parses the
 *      bytes. `text/plain` IS a CORS-safelisted content type, so
 *      `fetch(url, {method:"POST", mode:"no-cors", credentials:"include",
 *      headers:{"content-type":"text/plain"}, body:'{"text":"…"}'})` never
 *      preflights and every JSON route parses it happily.
 *   2. Many mutating routes ignore the body entirely and act on the path alone
 *      (`POST /api/tasks/[id]/merge`, `/abort`, `/clear`, `/pr`, `/sync`,
 *      `/merge/{prepare,complete,abort}`, `/api/recaps/sweep`,
 *      `/api/projects/[id]/refresh-context`, …), so even a bodyless
 *      `<form method="post">` reaches them. `POST /api/tasks/[id]/uploads`
 *      reads `multipart/form-data`, which is safelisted as well.
 * So the write surface is broadly reachable cross-site, up to and including
 * `POST /api/tasks/[id]/messages` — handing an arbitrary instruction to an
 * agent that runs under `bypassPermissions`. Non-simple methods (PUT/PATCH/
 * DELETE) always preflight and were never the exposure.
 *
 * The Access-mode HTTP rule is deliberately NARROWER than local mode's: reject
 * only when an Origin header is present and does not match Host. Local mode
 * additionally rejects `Sec-Fetch-Site: cross-site`, which would break an
 * ordinary cross-site top-level navigation — someone following a link to the
 * instance from an email or a wiki. Local mode gets away with that only because
 * nobody links to localhost; a tunnel hostname is exactly the kind of thing
 * people do link to. Cross-site navigations send no Origin, while cross-site
 * form posts and fetches do, so the narrow rule covers every vector above
 * without costing that click.
 *
 * This module is plain, Web-API-only ESM so Next middleware (edge runtime), the
 * unbundled CommonJS server.js, and the pty sidecar can use the exact same
 * policy.
 */

function normalizeOrigin(value) {
  if (!value || value === "null") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // Origins never carry a path/query/hash. Reject rather than silently
    // broadening a mistyped allowlist entry such as https://host/some/path.
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function hostnameFromHost(host) {
  if (!host) return null;
  try {
    // URL handles bracketed IPv6 and ports correctly. The scheme is irrelevant.
    return new URL(`http://${host}`).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname) {
  if (!hostname) return false;
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

function configuredOrigins(env) {
  const values = [
    env.PUBLIC_BASE_URL || "",
    ...(env.ORCH_ALLOWED_ORIGINS || "").split(","),
  ];
  return new Set(values.map((value) => normalizeOrigin(value.trim())).filter(Boolean));
}

function targetAllowed(host, env) {
  const hostname = hostnameFromHost(host);
  if (isLoopbackHostname(hostname)) return true;
  const normalizedHost = String(host || "").toLowerCase().replace(/\.$/, "");
  for (const origin of configuredOrigins(env)) {
    if (new URL(origin).host.toLowerCase() === normalizedHost) return true;
  }
  return false;
}

function originMatchesTarget(origin, host, env) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  const url = new URL(normalized);
  const normalizedHost = String(host || "").toLowerCase().replace(/\.$/, "");
  // Matching the target Host is what enforces same-origin, including the port.
  // Being present in the allowlist alone must not authorize a request aimed at
  // a different Host header.
  if (url.host.toLowerCase() !== normalizedHost) return false;
  if (isLoopbackHostname(url.hostname.toLowerCase())) return true;
  return configuredOrigins(env).has(normalized);
}

/**
 * Local HTTP requests may omit Origin when they come from curl, the MCP bridge,
 * health checks, or a top-level browser navigation. Browser requests that DO
 * declare an Origin must be same-origin, and Fetch Metadata gives us a second
 * guard for cross-site requests (including methods that omit Origin).
 *
 * `env` is annotated as a plain record rather than inheriting process.env's
 * NodeJS.ProcessEnv type: only two keys are ever read, and tests pass small
 * literals. Without this, strict tsc rejects every `{}` a test hands in for
 * missing NODE_ENV.
 *
 * @param {{host?: string|null, origin?: string|null, secFetchSite?: string|null}} req
 * @param {Record<string, string|undefined>} [env]
 */
export function localHttpRequestAllowed(
  { host, origin, secFetchSite },
  env = process.env,
) {
  if (!targetAllowed(host, env)) return false;
  if (String(secFetchSite || "").toLowerCase() === "cross-site") return false;
  return origin ? originMatchesTarget(origin, host, env) : true;
}

/**
 * A browser WebSocket handshake always includes Origin, so require it. This is
 * stricter than HTTP because /pty is an interactive shell and WebSockets are
 * not blocked by the browser's normal same-origin read protections.
 *
 * @param {{host?: string|null, origin?: string|null}} req
 * @param {Record<string, string|undefined>} [env]
 */
export function localWebSocketRequestAllowed({ host, origin }, env = process.env) {
  return targetAllowed(host, env) && originMatchesTarget(origin, host, env);
}

/* Does a PRESENT Origin belong to this instance? No target-host allowlist: in
 * Access mode the app is reached on whatever hostname the operator's tunnel
 * uses, PUBLIC_BASE_URL is genuinely optional, and the rebinding attack the
 * allowlist defends against cannot produce a valid assertion anyway.
 *
 * `configuredOrigins` is still honoured as the escape hatch for a proxy that
 * REWRITES Host (Cloudflare Tunnel's `httpHostHeader`, say): the browser's
 * Origin is then the public hostname while Host is the internal one, so the
 * operator names the public origin in PUBLIC_BASE_URL and it matches there.
 *
 * Kept as its own helper rather than inlined, so that if the Access-mode
 * WebSocket upgrade ever grows the same guard it shares this exact test instead
 * of a second copy that can drift. */
function originIsOurs(origin, host, env) {
  const normalized = normalizeOrigin(origin);
  // Also the `Origin: null` case (sandboxed iframe, cross-origin redirected
  // POST) — opaque, so it can never be shown to be ours.
  if (!normalized) return false;
  const normalizedHost = String(host || "").toLowerCase().replace(/\.$/, "");
  if (new URL(normalized).host.toLowerCase() === normalizedHost) return true;
  return configuredOrigins(env).has(normalized);
}

/**
 * The HTTP boundary for AUTHENTICATED (Cloudflare Access) mode, applied on top
 * of the JWT. The module header has the audit that says this is needed and the
 * reasoning for why the rule stops where it does.
 *
 * Absent Origin is ALLOWED, and that is the whole design, not an oversight: a
 * cross-site top-level navigation (a link from an email) sends no Origin, and
 * neither do curl, health checks or the MCP bridge. Every cross-site vector
 * that can mutate — form post, `no-cors` fetch, `text/plain` JSON — does send
 * one. Do not "harden" this into `localHttpRequestAllowed` by also rejecting
 * `Sec-Fetch-Site: cross-site`; that buys nothing here and breaks the link.
 *
 * @param {{host?: string|null, origin?: string|null}} req
 * @param {Record<string, string|undefined>} [env]
 */
export function sameOriginHttpRequestAllowed({ host, origin }, env = process.env) {
  if (!origin) return true;
  return originIsOurs(origin, host, env);
}

/**
 * Sanitize a user-supplied post-auth redirect down to a path on THIS host.
 *
 * Lives here with the other boundary rules because the obvious version is
 * wrong in two ways that are easy to reintroduce. `startsWith("/") &&
 * !startsWith("//")` looks sufficient, but browsers normalize a backslash to a
 * forward slash in the authority position, so "/\evil.com" is fetched as
 * "//evil.com" — a protocol-relative URL to the attacker. They also strip
 * tab/CR/LF from URLs before parsing, so "/\t/evil.com" collapses to
 * "//evil.com" too. Strip the ignorable characters FIRST, then reject anything
 * whose second character can begin an authority.
 *
 * @param {string|null|undefined} raw
 * @returns {string} a safe same-host path, or "/"
 */
export function safeRedirectPath(raw) {
  const s = String(raw || "").replace(/[\t\n\r]/g, "");
  if (!s.startsWith("/")) return "/";
  if (s[1] === "/" || s[1] === "\\") return "/";
  return s;
}

/**
 * Is this socket peer the machine itself?
 *
 * The pty sidecar's own gate, independent of any header. server.js already
 * checks Host/Origin before proxying /pty, but the sidecar spawns a real shell
 * for anyone who completes a handshake, so it must not depend on sitting behind
 * that proxy — a non-loopback PTY_HOST would otherwise be a way around the
 * whole boundary. Headers are attacker-controlled; the peer address is not,
 * which is exactly why this check is worth having next to the header one.
 *
 * Escape hatch for a deliberately split app/sidecar deployment:
 * ORCH_PTY_ALLOW_REMOTE=1. Anything that reaches the sidecar gets a shell, so
 * that opt-in means "I have my own network controls".
 *
 * @param {string|null|undefined} remoteAddress
 * @param {Record<string, string|undefined>} [env]
 */
export function isLoopbackPeer(remoteAddress, env = process.env) {
  if (env.ORCH_PTY_ALLOW_REMOTE === "1") return true;
  // Node reports IPv4 peers over a dual-stack socket as ::ffff:127.0.0.1.
  const addr = String(remoteAddress || "").replace(/^::ffff:/, "");
  return addr === "::1" || addr === "127.0.0.1" || addr.startsWith("127.");
}
