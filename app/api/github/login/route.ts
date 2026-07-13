import { NextResponse } from "next/server";
import { startLogin, getLogin, cancelLogin } from "@/lib/github";

export const dynamic = "force-dynamic";

// The guided "Connect GitHub" device flow. POST starts (or rejoins) a login
// and resolves once the one-time code is known; the UI then polls GET until
// the user authorizes on github.com; DELETE abandons the attempt. The session
// lives server-side (lib/github.ts) so a closed modal or page reload can pick
// the same login back up.

export async function POST() {
  return NextResponse.json(await startLogin());
}

export async function GET() {
  return NextResponse.json(getLogin() ?? { status: "idle", code: null, url: null, user: null, error: null });
}

export async function DELETE() {
  cancelLogin();
  return NextResponse.json({ ok: true });
}
