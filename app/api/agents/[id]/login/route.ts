import { NextResponse } from "next/server";
import { getDriverStrict } from "@/lib/agents/registry";
import { setAgentConnection } from "@/lib/agents/connections";

export const dynamic = "force-dynamic";

// Generalized, driver-driven connect flow — the agent-scoped mirror of
// app/api/claude/login. POST starts (or rejoins) the driver's headless login
// and resolves once the authorize URL is known; the UI polls GET until the user
// authorizes (and, for paste-code drivers like Claude, submits via ./code);
// DELETE abandons it. Because it resolves the driver by [id], agent #3 needs no
// new route — it just registers a driver with an auth surface.
//
// Unlike app/api/claude/login this persists per-agent connection state
// (lib/agents/connections.ts), NOT the single onboarding record: the wizard's
// required first step stays Claude-specific; this powers the "connect another
// agent" cards and the task-creation gating for every agent, Claude included.

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const driver = getDriverStrict(id);
  if (!driver) return NextResponse.json({ error: "unknown agent" }, { status: 404 });
  const s = await driver.startLogin();
  if (s.status === "success") setAgentConnection(id, { method: "subscription", email: s.email, plan: s.plan });
  return NextResponse.json(s);
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const driver = getDriverStrict(id);
  if (!driver) return NextResponse.json({ error: "unknown agent" }, { status: 404 });
  const s = driver.getLogin();
  if (s?.status === "success") setAgentConnection(id, { method: "subscription", email: s.email, plan: s.plan });
  return NextResponse.json(s ?? { status: "idle", url: null, email: null, plan: null, error: null, log: "" });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const driver = getDriverStrict(id);
  if (!driver) return NextResponse.json({ error: "unknown agent" }, { status: 404 });
  driver.cancelLogin();
  return NextResponse.json({ ok: true });
}
