import { type NextRequest, NextResponse } from "next/server";
import { activeProvider } from "@/lib/auth/origin.mjs";

export const dynamic = "force-dynamic";

/**
 * Log out of THIS instance. The session to end depends on the active origin
 * provider (see lib/auth/origin.mjs):
 *
 *   cf-access     — the cookie is Cloudflare's, set at the edge and re-verified
 *                   origin-side, so the origin can't delete it. Hand the browser
 *                   to Cloudflare's own logout endpoint, which clears it.
 *   none          — open local dev; nothing to end.
 *
 * Returns the redirect target rather than issuing a 3xx so the client can do a
 * top-level navigation (a fetch-following redirect to the CF logout would be
 * opaque).
 */
export async function POST(req: NextRequest) {
  const provider = activeProvider();

  if (provider === "cf-access") {
    return NextResponse.json({ ok: true, redirect: "/cdn-cgi/access/logout" });
  }

  return NextResponse.json({ ok: true, redirect: "/" });
}
