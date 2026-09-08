import { NextResponse } from "next/server";
import { z } from "zod";
import { createCommand, deleteCommand, getCommand, getProject, listCommands, updateCommand } from "@/lib/store";

const input = z.object({
  project_id: z.string().min(1).nullable().default(null),
  name: z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use a lowercase slug without / or spaces").refine((v) => v !== "clear", "/clear is reserved"),
  description: z.string().max(500).default(""),
  body: z.string().min(1).max(100000).refine((v) => !!v.trim(), "Prompt body is required"),
}).strict();
const error = (message: string, status: number) => NextResponse.json({ error: message }, { status });

export async function GET(req: Request) {
  const projectId = new URL(req.url).searchParams.get("project_id") ?? undefined;
  if (projectId !== undefined && !getProject(projectId)) return error("Project not found", 404);
  return NextResponse.json(listCommands(projectId));
}

async function save(req: Request, editing: boolean) {
  let json: unknown;
  try { json = await req.json(); } catch { return error("Invalid JSON", 400); }
  const schema = editing ? input.extend({ id: z.string().min(1) }) : input;
  const parsed = schema.safeParse(json);
  if (!parsed.success) return error(parsed.error.issues.map((i) => i.message).join("; "), 400);
  const data = parsed.data;
  const id = "id" in data ? data.id as string : undefined;
  if (id && !getCommand(id)) return error("Command not found", 404);
  if (data.project_id !== null && !getProject(data.project_id)) return error("Project not found", 404);
  try {
    return NextResponse.json(id ? updateCommand(id, data) : createCommand(data), { status: editing ? 200 : 201 });
  } catch (e) {
    if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") return error("A command with this name already exists in this scope", 409);
    throw e;
  }
}
export const POST = (req: Request) => save(req, false);
export const PATCH = (req: Request) => save(req, true);
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return error("Command id required", 400);
  if (!deleteCommand(id)) return error("Command not found", 404);
  return NextResponse.json({ ok: true });
}
