/* Cloudflare Access enforcement at the origin.
 *
 * Cloudflare Access authenticates users at the edge, but anything that can
 * reach the origin directly (host-loopback port, tunnel misconfig, another
 * process on the box) would bypass it entirely — and this app hands out a
 * shell. So every request must ALSO prove itself at the origin by presenting
 * the Access JWT (the `Cf-Access-Jwt-Assertion` header Access injects after
 * authenticating, with the `CF_Authorization` cookie as fallback), verified
 * against the team's public keys and this app's aud tag.
 *
 * One module, three consumers — keep them in sync by keeping the logic here:
 *   - middleware.ts        gates every HTTP route Next serves
 *   - server.js            gates WebSocket upgrades (the /pty terminal proxy)
 *   - app/api/me/route.ts  surfaces the authenticated email in the UI
 *
 * Plain .mjs on purpose: middleware.ts imports it through Next's bundler
 * (edge runtime — jose and this file use only Web APIs), while server.js is
 * un-bundled CommonJS and loads it with a dynamic import(). jose v6 is
 * ESM-only, so this is the one shape that serves both.
 *
 * Config (see .env.example):
 *   CF_ACCESS_TEAM_DOMAIN  e.g. your-team.cloudflareaccess.com
 *   CF_ACCESS_AUD          the Access application's aud tag (comma-separable)
 *   SERVICE_TOKEN          shared secret for the health-check bypass
 *
 * Enforcement is ON iff TEAM_DOMAIN and AUD are both set — local dev runs
 * open by default; the per-user containers set both (docs/DEPLOY.md).
 */
import { createRemoteJWKSet, jwtVerify } from "jose";

// Read env lazily (not at module top) so `next build` can evaluate this file
// without the runtime configuration present.
function teamDomain() {
  return (process.env.CF_ACCESS_TEAM_DOMAIN || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}
function audiences() {
  return (process.env.CF_ACCESS_AUD || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function accessEnabled() {
  return Boolean(teamDomain() && audiences().length);
}

// createRemoteJWKSet caches keys and rate-limits refetches; keep one instance
// per process (module scope survives across requests in middleware too).
let jwks = null;
let jwksDomain = "";
function getJwks(domain) {
  if (!jwks || jwksDomain !== domain) {
    jwks = createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`));
    jwksDomain = domain;
  }
  return jwks;
}

/** Extract the Access JWT from a Node http.IncomingMessage (server.js upgrade
 * path). Access injects the header on every origin-bound request; the cookie
 * fallback covers proxies that strip nonstandard headers. */
export function assertionFromNodeRequest(req) {
  const h = req.headers["cf-access-jwt-assertion"];
  if (typeof h === "string" && h) return h;
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.cookie || "");
  return m ? decodeURIComponent(m[1]) : null;
}

/** Verify signature (team JWKS), issuer (team domain) and audience (app aud
 * tag). Throws on any failure; returns the authenticated identity on success. */
export async function verifyAccessJwt(token) {
  if (!token) throw new Error("missing Cf-Access-Jwt-Assertion");
  const domain = teamDomain();
  const { payload } = await jwtVerify(token, getJwks(domain), {
    issuer: `https://${domain}`,
    audience: audiences(),
  });
  return {
    email: typeof payload.email === "string" ? payload.email : null,
    payload,
  };
}

function constantTimeEq(presented, expected) {
  if (!expected || !presented || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/** The non-Access paths: health/version/usage probes (Docker HEALTHCHECK and the
 * control plane hit /api/instance/{idle,usage} and /api/version from inside or
 * alongside the container, where no Access JWT exists). Two accepted secrets:
 *
 *   SERVICE_TOKEN     the per-instance token (unique per box; also what
 *                     orch-sleepd uses to poll idleness).
 *   ORCH_FLEET_TOKEN  an optional fleet-WIDE read token shared by every box and
 *                     the control plane, so the metrics dashboard can poll the
 *                     whole fleet with one secret instead of learning each box's
 *                     private SERVICE_TOKEN. Read-only paths only.
 *
 * Constant-time compare against each; no token configured on a side = no bypass
 * from that side. */
export function serviceTokenOk(presented) {
  return (
    constantTimeEq(presented, process.env.SERVICE_TOKEN || "") ||
    constantTimeEq(presented, process.env.ORCH_FLEET_TOKEN || "")
  );
}

/** Strict variant: ONLY the per-instance SERVICE_TOKEN, never the fleet-wide
 * read token. Guards the internal agent-tool endpoints, which MUTATE (create
 * tasks / register services) and so must not be reachable with a read-only
 * fleet secret shared across boxes. */
export function instanceServiceTokenOk(presented) {
  return constantTimeEq(presented, process.env.SERVICE_TOKEN || "");
}
