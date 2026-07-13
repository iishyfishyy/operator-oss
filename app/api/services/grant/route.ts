import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getGateSecret, publicServiceHost } from "@/lib/services";
import { mintGateToken } from "@/lib/service-host.mjs";

export const dynamic = "force-dynamic";

// Session → service-host handoff for private (and shared) services. This route
// lives on the APP hostname, so middleware.ts has already enforced the
// instance's normal session auth before we get here — reaching this handler IS
// the proof of identity. We mint a short-lived slug-bound token and bounce the
// browser to <slug>--<host>/__orch/auth, where the service router swaps it for
// a host-scoped gate cookie (lib/service-router.mjs). The token never outlives
// the hop by much, and only ever admits to the one service.
const HOP_TTL_MS = 5 * 60 * 1000;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug") || "";
  const next = url.searchParams.get("next") || "/";
  const row = getDb().prepare("SELECT slug FROM services WHERE slug = ?").get(slug) as
    | { slug: string }
    | undefined;
  const host = row ? publicServiceHost(row.slug) : null;
  if (!row || !host) {
    return NextResponse.json({ error: "unknown service" }, { status: 404 });
  }
  const token = mintGateToken(getGateSecret(), row.slug, HOP_TTL_MS);
  const base = new URL(process.env.PUBLIC_BASE_URL!);
  const portSuffix = base.port ? `:${base.port}` : "";
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const target = `${base.protocol}//${host}${portSuffix}/__orch/auth?t=${encodeURIComponent(token)}&next=${encodeURIComponent(safeNext)}`;
  return NextResponse.redirect(target, 302);
}
