import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { taskUploadsDir, MIME_BY_EXT } from "@/lib/uploads";

export const dynamic = "force-dynamic";

// Server-generated names only (nanoid + whitelisted extension) — this is the
// traversal guard, so both segments are validated before touching the fs.
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;
const SAFE_FILE = /^([A-Za-z0-9_-]+)\.(png|jpg|gif|webp|txt)$/;

/** Serve an uploaded chat attachment (image thumbnail or text file). Auth: middleware. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await params;
  const m = SAFE_FILE.exec(file);
  if (!SAFE_SEGMENT.test(id) || !m) return NextResponse.json({ error: "not found" }, { status: 404 });
  const abs = path.join(taskUploadsDir(id), file);
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": MIME_BY_EXT[m[2]] ?? "application/octet-stream",
      // Filenames are unique nanoids and never rewritten — cache hard.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
