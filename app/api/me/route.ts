import { type NextRequest } from "next/server";
import { originAuthEnabled, verifyOriginRequest } from "@/lib/auth/origin.mjs";

export const dynamic = "force-dynamic";

/**
 * Who is signed in, per the active origin auth provider (Cloudflare Access or a
 * first-party control-plane session) — the titlebar shows this so it's obvious
 * which identity unlocked the instance. middleware.ts has already rejected
 * unauthenticated requests; re-verifying here (instead of trusting a forwarded
 * header) keeps the email claim tamper-proof for free. `email: null` when
 * enforcement is off (local dev).
 */
export async function GET(req: NextRequest) {
  if (!originAuthEnabled()) return Response.json({ enabled: false, email: null });
  try {
    const { email } = await verifyOriginRequest(req);
    return Response.json({ enabled: true, email });
  } catch {
    return Response.json({ enabled: true, email: null }, { status: 403 });
  }
}
