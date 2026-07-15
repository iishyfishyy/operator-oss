import { NextResponse } from "next/server";

/**
 * Last-resort JSON guard for API route handlers. Next renders an uncaught route
 * throw (or a request killed at maxDuration) as an HTML error page; a client
 * that then calls res.json() surfaces the useless "Unexpected token '<',
 * '<!DOCTYPE'… is not valid JSON" instead of the real failure. Wrap the whole
 * handler body so every escape path — including bugs — still returns JSON with
 * the actual error message.
 */
export async function jsonGuard(label: string, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    console.error(`[api] ${label} failed:`, e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
