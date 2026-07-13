import { NextResponse } from "next/server";
import { listProjects, createProject } from "@/lib/store";
import { track } from "@/lib/analytics";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(listProjects());
}

export async function POST(req: Request) {
  const body = await req.json();
  if (!body?.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
  const project = createProject({
    name: body.name.trim(),
    icon: body.icon,
    sub: body.sub,
    color: body.color,
    context: body.context,
    repo_path: body.repo_path,
    branch: body.branch,
  });
  track("project_created", { project_id: project.id, has_repo: !!project.repo_path });
  return NextResponse.json(project, { status: 201 });
}
