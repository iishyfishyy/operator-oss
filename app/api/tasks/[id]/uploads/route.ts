import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { getTask } from "@/lib/store";
import { taskUploadsDir, UPLOAD_EXT_BY_MIME, MAX_UPLOAD_BYTES } from "@/lib/uploads";

export const dynamic = "force-dynamic";

/**
 * Attach an image to a task's chat. Saves the file under DB_DIR/uploads/<task>/
 * (outside the worktree — see lib/uploads.ts) and returns both the absolute
 * path (embedded in the message for Claude to Read) and the serving URL (for
 * transcript thumbnails). The composer uploads eagerly on attach; the file only
 * enters the conversation when the message referencing it is sent.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Reject oversized bodies before parsing — formData() throws unhelpfully on
  // huge payloads, and this saves buffering them at all. (+4KB multipart slack.)
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_UPLOAD_BYTES + 4096) {
    return NextResponse.json({ error: `Attachment too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).` }, { status: 413 });
  }

  let entry: FormDataEntryValue | null;
  try {
    entry = (await req.formData()).get("file");
  } catch {
    return NextResponse.json({ error: "expected multipart form data" }, { status: 400 });
  }
  // Duck-typed rather than `instanceof File` — Node 18 has no global File.
  if (!entry || typeof entry === "string") return NextResponse.json({ error: "missing file" }, { status: 400 });
  const file = entry;
  // file.type may carry a charset (e.g. "text/plain;charset=utf-8"); match on
  // the bare MIME type.
  const ext = UPLOAD_EXT_BY_MIME[file.type.split(";")[0].trim()];
  if (!ext) {
    return NextResponse.json({ error: "Only PNG, JPEG, GIF, WebP images or plain text are supported." }, { status: 415 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: `Attachment too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).` }, { status: 413 });
  }

  const dir = taskUploadsDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${nanoid()}.${ext}`;
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, Buffer.from(await file.arrayBuffer()));
  return NextResponse.json({ ok: true, path: abs, url: `/api/tasks/${id}/uploads/${name}`, name: file.name || name });
}
