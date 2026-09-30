/* Origin-side auth gate for every HTTP route. The active provider is chosen by
 * env (lib/auth/origin.mjs): open local mode by default, or Cloudflare Access
 * when configured. lib/cf-access.mjs has the threat model; server.js guards the
 * WebSocket side the same way.
 *
 * No `matcher` config on purpose: this must cover _next assets, public/ files
 * and every API route alike — a per-user instance is single-user and there is
 * nothing an unauthenticated client should fetch. The JWKS / secret is cached in
 * module scope, so the per-request cost after the first verification is local
 * crypto.
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  originAuthEnabled,
  serviceTokenOk,
  instanceServiceTokenOk,
  verifyOriginRequest,
} from "@/lib/auth/origin.mjs";
import {
  localHttpRequestAllowed,
  sameOriginHttpRequestAllowed,
} from "@/lib/auth/local-origin.mjs";

// The non-Access paths: health probes (Docker HEALTHCHECK / monitoring) and
// the build-version stamp present the shared SERVICE_TOKEN instead of an Access
// JWT — and may reach ONLY these routes.
const HEALTH_PATH = "/api/instance/idle";
const VERSION_PATH = "/api/version";
const USAGE_PATH = "/api/instance/usage";
// The boot-time self-ping from server.js that restores persisted services.
const SERVICES_RESTORE_PATH = "/api/instance/services-restore";
function isServiceTokenPath(pathname: string): boolean {
  return (
    pathname === HEALTH_PATH ||
    pathname === VERSION_PATH ||
    pathname === USAGE_PATH ||
    pathname === SERVICES_RESTORE_PATH
  );
}

// The internal endpoints the stdio MCP bridge (scripts/orch-mcp.mjs) proxies the
// agent tool calls to. No Access JWT exists in that server-to-server call, so it
// presents the per-instance SERVICE_TOKEN instead. These MUTATE, so they demand
// the strict instance token (never the read-only fleet token) — see cf-access.mjs.
const AGENT_TOOLS_PREFIX = "/api/internal/agent-tools/";
function isAgentToolPath(pathname: string): boolean {
  return pathname.startsWith(AGENT_TOOLS_PREFIX);
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Local mode has no login, but it is not an unbounded browser trust zone.
  // Restrict Host to loopback/configured origins (DNS-rebinding defense), reject
  // cross-site Fetch Metadata, and require any supplied Origin to match Host.
  // Raw local clients such as curl, health checks, and the MCP bridge omit the
  // browser headers and remain supported as long as their Host is allowed.
  if (!originAuthEnabled()) {
    return localHttpRequestAllowed({
      host: req.headers.get("host"),
      origin: req.headers.get("origin"),
      secFetchSite: req.headers.get("sec-fetch-site"),
    })
      ? NextResponse.next()
      : new NextResponse("Forbidden: local origin not allowed.\n", {
          status: 403,
          headers: { "content-type": "text/plain" },
        });
  }

  // Access mode: the JWT proves WHO, never WHETHER THEY MEANT IT. `CF_Authorization`
  // is SameSite=None, so the edge stamps a valid assertion onto a request a hostile
  // page made the victim's browser send. Reject a cross-origin browser caller before
  // any of the auth paths below — deliberately the narrow Origin-vs-Host rule, not
  // local mode's, so a cross-site link to the instance still opens. See the audit in
  // lib/auth/local-origin.mjs for what is reachable without it.
  if (!sameOriginHttpRequestAllowed({
    host: req.headers.get("host"),
    origin: req.headers.get("origin"),
  })) {
    return new NextResponse("Forbidden: cross-origin request.\n", {
      status: 403,
      headers: { "content-type": "text/plain" },
    });
  }

  if (isServiceTokenPath(pathname) && serviceTokenOk(req.headers.get("x-service-token"))) {
    return NextResponse.next();
  }

  // The internal agent-tool endpoints authenticate with the instance
  // SERVICE_TOKEN (no Access JWT exists in that server-to-server call). They
  // mutate, so they demand the strict per-instance token — the read-only fleet
  // token is rejected — and never fall through to the JWT verify below.
  if (isAgentToolPath(pathname)) {
    return instanceServiceTokenOk(req.headers.get("x-service-token"))
      ? NextResponse.next()
      : new NextResponse("Forbidden.\n", { status: 403, headers: { "content-type": "text/plain" } });
  }

  try {
    await verifyOriginRequest(req);
    return NextResponse.next();
  } catch {
    // A real user behind the active provider always carries a valid credential;
    // landing here means the request skipped it. Deny flatly — no redirect that
    // would leak the team domain.
    return new NextResponse("Forbidden: authentication required.\n", {
      status: 403,
      headers: { "content-type": "text/plain" },
    });
  }
}
