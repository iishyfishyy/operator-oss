import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";

export const dynamic = "force-dynamic";

// Opens the OS-native "choose folder" dialog so the user gets real Finder
// features (search, ⌘⇧N new folder, sidebar favorites, iCloud/network volumes)
// instead of our hand-rolled in-app browser. The dialog renders on the machine
// running this server — which, for this local-first app, is the user's own Mac.
//
// Returns one of:
//   { path }            — a folder was chosen
//   { canceled: true }  — the user dismissed the dialog
//   { unsupported: true}— no native dialog available (non-macOS / headless);
//                         the client falls back to the in-app FolderPicker.

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5 * 60_000 }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException).code === "number" ? (err as unknown as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
    });
  });
}

async function pickMac(initial?: string): Promise<NextResponse> {
  // Only seed the default location when the path actually exists, otherwise
  // `choose folder` throws instead of opening.
  let defaultLoc = "";
  if (initial && initial.trim()) {
    try {
      const st = await fs.stat(initial.trim());
      const dir = st.isDirectory() ? initial.trim() : os.homedir();
      const esc = dir.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      defaultLoc = ` default location (POSIX file "${esc}")`;
    } catch {
      /* fall through with no default location */
    }
  }
  // `activate` pulls the dialog to the foreground above the browser window.
  const script = `activate\nset chosenFolder to (choose folder with prompt "Select the project working directory"${defaultLoc})\nreturn POSIX path of chosenFolder`;
  const { code, stdout, stderr } = await run("osascript", ["-e", script]);
  if (code === 0) {
    const path = stdout.trim().replace(/\/$/, "");
    if (path) return NextResponse.json({ path });
    return NextResponse.json({ canceled: true });
  }
  // osascript exits non-zero with "User canceled. (-128)" when dismissed.
  if (/-128|User canceled/i.test(stderr)) return NextResponse.json({ canceled: true });
  return NextResponse.json({ unsupported: true, error: stderr.trim() || "native dialog unavailable" });
}

export async function POST(req: Request) {
  let initial: string | undefined;
  try {
    const body = await req.json();
    if (body && typeof body.initial === "string") initial = body.initial;
  } catch {
    /* no body is fine */
  }

  if (process.platform === "darwin") return pickMac(initial);
  // Linux/Windows GUI dialogs (zenity/PowerShell) could be added here later.
  return NextResponse.json({ unsupported: true });
}
