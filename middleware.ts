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

  // Local dev with no origin provider configured runs fully open (single-user
  // machine) — same as every other route.
  if (!originAuthEnabled()) return NextResponse.next();

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
