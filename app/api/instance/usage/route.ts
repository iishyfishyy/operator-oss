import { getInstanceUsage } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Instance-wide usage rollup, for the control plane's fleet metrics. A single
 * summary row (project/task counts + cumulative cost/tokens from task_usage) so
 * the operator sees rough per-user usage without SSHing into the box or fanning
 * out per project.
 *
 * Like /api/instance/idle and /api/version this is exempt from the Access/origin
 * gate ONLY for callers presenting SERVICE_TOKEN (or the fleet read token) — see
 * middleware.ts. It exposes counts and spend, never task titles or content.
 */
export async function GET() {
  return Response.json({ now: Date.now(), ...getInstanceUsage() });
}
