export interface PromptSection { label: string; text: string }
export interface PromptCapture {
  id: string;
  createdAt: number;
  projectId: string;
  taskId?: string;
  generation?: number;
  agent: string;
  job: string;
  sessionId: string | null;
  prompt: string;
  systemAppend?: string;
  sections: PromptSection[];
  options: Record<string, unknown>;
}

/** Strip Operator's task-detail label for comparison, preserving the body exactly. */
export const comparableLine = (line: string) => line.replace(/^Task details: /, "");

/** Exact repeated nonblank line bodies, including task details in context. */
export function duplicateLines(text: string): Set<string> {
  const counts = new Map<string, number>();
  for (const raw of text.split("\n")) {
    const line = comparableLine(raw);
    if (line.trim().length >= 40) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([line]) => line));
}

/** A bounded, exact replacement diff (common prefix/suffix, no quadratic LCS). */
export function promptDiff(before: string, after: string): string {
  const a = before.split("\n"), b = after.split("\n");
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  if (start === a.length && start === b.length) return "No text changes.";
  return [...a.slice(Math.max(0, start - 2), start).map(l => `  ${l}`),
    ...a.slice(start, a.length - end).map(l => `- ${l}`),
    ...b.slice(start, b.length - end).map(l => `+ ${l}`),
    ...b.slice(b.length - end, b.length - end + 2).map(l => `  ${l}`)].join("\n");
}
