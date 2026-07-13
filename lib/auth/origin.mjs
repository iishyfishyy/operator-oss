/* Origin auth provider seam.
 *
 * A deployed instance must verify, at its own origin, that a request is from
 * its allowed user — edge auth alone leaves the published port open (the app
 * hands out a shell). Providers are selected by env:
 *
 *   CF_ACCESS_* unset (default)               -> open local mode (single-user
 *                                                machine, no origin gate)
 *   ORCH_AUTH_PROVIDER unset / "cf-access"    -> Cloudflare Access JWT, once
 *                                                CF_ACCESS_* is configured
 *
 * The branch is edge-runtime safe (Web APIs + jose only).
 */
// Relative (not `@/`) imports on purpose: this module is loaded both by Next's
// bundler (middleware) AND by raw Node ESM (server.js dynamic import), and the
// `@/` alias only resolves under the bundler.
import {
  accessEnabled,
  assertionFromNodeRequest,
  serviceTokenOk,
  instanceServiceTokenOk,
  verifyAccessJwt,
} from "../cf-access.mjs";

/** Is origin enforcement on at all? (Off in local dev = open.) */
export function originAuthEnabled() {
  return accessEnabled();
}

/**
 * Which provider is gating this origin — drives the logout UX (the session to
 * end and where to send the browser afterward differ per provider):
 *   "cf-access"      Cloudflare Access cookie    -> /cdn-cgi/access/logout
 *   "none"           open (local dev)            -> nothing to end
 */
export function activeProvider() {
  if (accessEnabled()) return "cf-access";
  return "none";
}

/** The shared health-probe bypass (service token), provider-independent. */
export { serviceTokenOk };

/** Strict per-instance token check for the mutating internal agent-tool endpoints. */
export { instanceServiceTokenOk };

/** Verify a request against the active provider; resolves to { email } or throws. */
export async function verifyOriginRequest(req) {
  const token =
    req.headers.get("cf-access-jwt-assertion") ||
    req.cookies?.get?.("CF_Authorization")?.value ||
    null;
  return verifyAccessJwt(token);
}

/** Same, for a raw Node http IncomingMessage (the WebSocket upgrade in server.js). */
export async function verifyOriginNodeRequest(req) {
  return verifyAccessJwt(assertionFromNodeRequest(req));
}
