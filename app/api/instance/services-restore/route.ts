import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Boot trigger for the persisted service registry. server.js pings this over
// loopback right after listen (with the service token, mirroring the health
// probes) so managed services with desired_state='running' restart with the
// server — not on the first user request. Idempotent: restoreServices() runs
// once per process, so re-hitting this (or a user beating the ping) is safe.
// An instrumentation.ts hook would be the idiomatic home, but Turbopack dev
// tries to bundle better-sqlite3 into its edge variant and breaks the app.
//
// lib/services is imported DYNAMICALLY on purpose: its module graph reaches the
// ESM agent-SDK externals, so Turbopack compiles it as an async module — and in
// the production build this route's static namespace import was grabbed before
// that async factory resolved, leaving restoreServices undefined at request
// time (a 500 on every boot ping). `await import()` always waits for the
// module to finish initializing.
export async function POST() {
  const { restoreServices } = await import("@/lib/services");
  await restoreServices();
  return NextResponse.json({ ok: true });
}
