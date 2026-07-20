import { NextResponse } from "next/server";
import { getProject } from "@/lib/store";
import {
  listServices, startService, stopService, restartService,
  setServiceVisibility, rotateShareToken,
} from "@/lib/services";
import type { ServiceVisibility } from "@/lib/types";

export const dynamic = "force-dynamic";

// The project's services + their live status (dev/setup/test commands, plus any
// exposed entries). Stopped configured commands are included so the UI can start them.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ services: listServices(project), port: project.port });
}

// Act on one service. Body: { name, action } where action is start / stop /
// restart, or visibility (with { value }) / rotate_token for the share controls.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { name, action, value } = await req.json();
  if (typeof name !== "string" || !name) return NextResponse.json({ error: "name required" }, { status: 400 });
  try {
    let info;
    if (action === "start") info = await startService(project, name);
    else if (action === "stop") info = stopService(project.id, name);
    else if (action === "restart") info = await restartService(project, name);
    else if (action === "visibility") info = setServiceVisibility(project, name, value as ServiceVisibility);
    else if (action === "rotate_token") info = rotateShareToken(project, name);
    else return NextResponse.json({ error: "unknown action" }, { status: 400 });
    return NextResponse.json({ service: info });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
