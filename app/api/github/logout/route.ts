import { NextResponse } from "next/server";
import { ghLogout } from "@/lib/github";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await ghLogout();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "logout failed" }, { status: 500 });
  }
}
