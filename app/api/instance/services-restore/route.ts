import { NextResponse } from "next/server";
import { restoreServices } from "@/lib/services";

export const dynamic = "force-dynamic";

// Boot trigger for the persisted service registry. server.js pings this over
// loopback right after listen (with the service token, mirroring the health
// probes) so managed services with desired_state='running' restart with the
// server — not on the first user request. Idempotent: restoreServices() runs
// once per process, so re-hitting this (or a user beating the ping) is safe.
// An instrumentation.ts hook would be the idiomatic home, but Turbopack dev
// tries to bundle better-sqlite3 into its edge variant and breaks the app.
export async function POST() {
  restoreServices();
  return NextResponse.json({ ok: true });
}
