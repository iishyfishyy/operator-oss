import { AsyncLocalStorage } from "node:async_hooks";
import { nanoid } from "nanoid";
import { getDb } from "./db";
import { resolveFeatures } from "./features";
import type { PromptCapture, PromptSection } from "./promptCaptureTypes";

type Scope = { projectId: string; taskId?: string; generation?: number; job: string };
declare global { var __orchPromptScope: AsyncLocalStorage<Scope> | undefined }
export const promptScope = globalThis.__orchPromptScope ??= new AsyncLocalStorage<Scope>();

/** Labels annotate exact substrings; the raw SDK arguments remain authoritative. */
export function contextSections(context: string): PromptSection[] {
  const markers = /(?=\nWhat we're building \(project context\):|\nGit branch:|\n---\nThe current task is:|\n--- Carried context|\n---\nYou have an "orchestrator"|\nYou also have an `expose_service`)/;
  return context.split(markers).filter(Boolean).map(text => ({
    label: text.includes("What we're building (project context):") ? "Project context" :
      text.startsWith("\nGit branch:") ? "Branch" : text.startsWith("\n---\nThe current task") ? "Task description" :
      text.startsWith("\n--- Carried context") ? "Carried summaries" :
      text.startsWith("\n---\nYou have an ") || text.startsWith("\nYou also have an ") ? "Orchestrator instructions" : "Project framing",
    text,
  }));
}

export function capturePrompt(input: Omit<PromptCapture, "id" | "createdAt" | "projectId" | "job" | "sections"> & {
  projectId?: string; job?: string; sections?: PromptSection[];
}): void {
  if (!resolveFeatures().debugPrompts) return;
  try {
    const scope = promptScope.getStore();
    const projectId = input.projectId ?? scope?.projectId;
    if (!projectId) return;
    const capture: PromptCapture = {
      ...scope, ...input, projectId, job: input.job ?? scope?.job ?? "turn",
      id: nanoid(), createdAt: Date.now(),
      sections: input.sections ?? [{ label: "User prompt", text: input.prompt }],
    };
    const payload = JSON.stringify(capture);
    const bytes = Buffer.byteLength(payload);
    // Keep exact captures or skip them entirely, never silently truncate.
    if (bytes > 8 * 1024 * 1024) { console.warn("[prompt inspector] Capture exceeds 8 MiB; skipped"); return; }
    const db = getDb();
    db.transaction(() => {
      db.prepare("INSERT INTO prompt_captures VALUES (?, ?, ?, ?, ?, ?)")
        .run(capture.id, projectId, capture.taskId ?? null, capture.createdAt, bytes, payload);
      db.prepare("DELETE FROM prompt_captures WHERE created_at < ?").run(Date.now() - 7 * 86400000);
      // Global bounds: 200 captures / 32 MiB, newest first.
      db.exec(`DELETE FROM prompt_captures WHERE id IN (
        SELECT id FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at DESC, rowid DESC) AS n,
        SUM(bytes) OVER (ORDER BY created_at DESC, rowid DESC) AS total FROM prompt_captures)
        WHERE n > 200 OR total > 33554432)`);
    })();
  } catch {
    // Debugging must never prevent a provider call, nor leak prompt contents to logs.
    console.warn("[prompt inspector] Could not persist capture");
  }
}

export function listPromptCaptures(projectId: string, taskId: string): PromptCapture[] {
  if (!resolveFeatures().debugPrompts) return [];
  getDb().prepare("DELETE FROM prompt_captures WHERE created_at < ?").run(Date.now() - 7 * 86400000);
  return (getDb().prepare(`SELECT payload FROM prompt_captures
    WHERE project_id = ? AND (task_id = ? OR task_id IS NULL) AND created_at >= ?
    ORDER BY created_at DESC, rowid DESC LIMIT 200`).all(projectId, taskId, Date.now() - 7 * 86400000) as { payload: string }[])
    .map(row => JSON.parse(row.payload));
}
