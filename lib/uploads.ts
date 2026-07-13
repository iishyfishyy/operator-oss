import fs from "node:fs";
import path from "node:path";
import { DB_DIR } from "@/lib/config";

// Chat attachments (images + large text pastes). Uploaded files live under the
// DB dir, deliberately OUTSIDE the task's git worktree — a pasted screenshot or
// a 500 KB log dump must never show up in the task's diff or get swept into a
// merge. The message text carries a marker line with the absolute path (see
// attachmentMarker / fileAttachmentMarker in app/orchestrator/format.ts);
// Claude Code opens it with its Read tool (rendering images natively, reading
// text files as text), so no SDK content-block plumbing is needed and
// queued/pending messages keep working as plain text.

export const UPLOADS_DIR = path.join(DB_DIR, "uploads");

// Image types Claude Code's Read tool can render. Keys are browser MIME types,
// values the on-disk extension (also the URL-safe serving whitelist).
export const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

// Everything the upload route accepts: images plus plain text (a big paste the
// composer diverts to a file instead of inlining, see PASTE_ATTACH_THRESHOLD).
export const UPLOAD_EXT_BY_MIME: Record<string, string> = {
  ...IMAGE_EXT_BY_MIME,
  "text/plain": "txt",
};

export const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain; charset=utf-8",
};

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB per attachment

export function taskUploadsDir(taskId: string): string {
  return path.join(UPLOADS_DIR, taskId);
}

/** Best-effort removal of a task's attachment dir (task/project hard delete). */
export function removeTaskUploads(taskId: string): void {
  try {
    fs.rmSync(taskUploadsDir(taskId), { recursive: true, force: true });
  } catch {
    // best-effort — orphaned files are harmless
  }
}
