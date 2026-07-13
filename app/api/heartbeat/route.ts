import { NextResponse } from "next/server";
import { activity } from "@/lib/idle";
import { track } from "@/lib/analytics";

export const dynamic = "force-dynamic";

// Time-in-app + retention signal. The app pings this on load and on a timer
// (see app/Orchestrator.tsx). Emitting server-side — rather than trusting the
// browser SDK — means retention/return-frequency hold up even when posthog-js
// is blocked, and it reuses lib/idle.ts's activity snapshot for context.
//
// A run of pings inside IDLE_GAP is one "session": the first ping (fresh
// process, or after a gap) is app_opened; the rest are heartbeats. Kept on
// globalThis so Next route-module reloads don't reset the session.

const IDLE_GAP_MS = 30 * 60 * 1000; // a gap this long starts a new app_opened

declare global {
  // eslint-disable-next-line no-var
  var __orchLastBeat: number | undefined;
}

export async function POST() {
  const a = activity();
  const now = Date.now();
  const props = {
    open_sse: a.openSse,
    open_pty: a.openPty,
    open_work: a.openWork,
    uptime_s: Math.round((now - a.startedAt) / 1000),
  };
  const fresh = !global.__orchLastBeat || now - global.__orchLastBeat > IDLE_GAP_MS;
  global.__orchLastBeat = now;
  track(fresh ? "app_opened" : "heartbeat", props);
  return NextResponse.json({ ok: true });
}
