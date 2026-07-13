import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

export const dynamic = "force-dynamic";

// Lists directories so the project-context editor can offer a folder browser
// instead of forcing the user to hand-type a working-dir path. Read-only.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const home = os.homedir();
  const showHidden = url.searchParams.get("hidden") === "1";
  const raw = url.searchParams.get("path");
  // Default to the user's home directory; resolve to an absolute path.
  let dir = raw && raw.trim() ? path.resolve(raw.trim()) : home;

  let stat;
  try {
    stat = await fs.stat(dir);
  } catch {
    return NextResponse.json({ error: `Not found: ${dir}` }, { status: 404 });
  }
  // If the path is a file, browse its containing directory instead.
  if (!stat.isDirectory()) dir = path.dirname(dir);

  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return NextResponse.json({ error: `Cannot read: ${dir}` }, { status: 403 });
  }

  const entries = dirents
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .filter((d) => showHidden || !d.name.startsWith("."))
    .map((d) => ({ name: d.name, path: path.join(dir, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const parent = path.dirname(dir);
  return NextResponse.json({
    path: dir,
    parent: parent === dir ? null : parent,
    home,
    entries,
  });
}
