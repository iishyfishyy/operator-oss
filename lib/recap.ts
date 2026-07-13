import {
  getProject,
  listProjects,
  listTasks,
  listSummaries,
  listMessages,
  projectLastActivity,
  projectHasHistory,
  setProjectRecap,
} from "./store";
import { summarizeProjectRecap } from "./agents/oneshots";
import { recentCommits } from "./git";
import type { Project } from "./types";

// How long a project must sit idle before a recap is considered worthwhile —
// "it's been a while since I worked on this". Tunable; kept modest so the
// feature is easy to exercise. (8 hours.)
export const RECAP_STALE_MS = 8 * 60 * 60 * 1000;

// Projects currently mid-generation, so the sweep and on-open paths don't
// kick off a second recap turn for the same project. Module-level = per server.
const inFlight = new Set<string>();

export interface RecapStatus {
  recap: string | null;
  recap_at: number;
  hasHistory: boolean;
  stale: boolean;
  needsRecap: boolean; // stale + has new activity since the last recap + has history
  generating: boolean;
  lastActivity: number;
}

export function recapStatus(project: Project): RecapStatus {
  const lastActivity = projectLastActivity(project.id);
  const hasHistory = projectHasHistory(project.id);
  const stale = lastActivity > 0 && Date.now() - lastActivity >= RECAP_STALE_MS;
  const hasNewActivity = lastActivity > (project.recap_covers_at || 0);
  return {
    recap: project.recap || null,
    recap_at: project.recap_at || 0,
    hasHistory,
    stale,
    needsRecap: hasHistory && stale && hasNewActivity,
    generating: inFlight.has(project.id),
    lastActivity,
  };
}

// Assemble the recent-activity digest fed to the utility agent: one block per started task
// (most-recently-touched first), preferring its latest /clear summary, else the
// tail of its last assistant message.
function buildDigest(project: Project): { digest: string; coversAt: number } | null {
  const tasks = listTasks(project.id)
    .filter((t) => !t.suggested && t.started)
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 8);
  if (tasks.length === 0) return null;

  const parts = tasks.map((t) => {
    const summaries = listSummaries(t.id);
    const lastSummary = summaries.length ? summaries[summaries.length - 1].summary : null;
    let detail: string;
    if (lastSummary) {
      detail = `Latest session summary: ${lastSummary}`;
    } else {
      const lastAssistant = listMessages(t.id)
        .filter((m) => m.role === "assistant")
        .slice(-1)
        .map((m) => m.content)
        .join("")
        .slice(0, 600);
      detail = lastAssistant ? `Last activity: ${lastAssistant}` : "(no recorded detail)";
    }
    return `## Task: ${t.title} [${t.status}]\n${t.description ? t.description + "\n" : ""}${detail}`;
  });

  return { digest: parts.join("\n\n"), coversAt: projectLastActivity(project.id) };
}

// Generate + persist a recap for one project. Returns the recap text, or null
// if there's nothing to recap or a generation is already in flight.
export async function generateRecap(projectId: string): Promise<string | null> {
  if (inFlight.has(projectId)) return null;
  const project = getProject(projectId);
  if (!project) return null;
  const built = buildDigest(project);
  if (!built) return null;

  inFlight.add(projectId);
  try {
    let digest = built.digest;
    const commits = await recentCommits(project.repo_path, 10).catch(() => "");
    if (commits) digest += `\n\n## Recent git commits\n${commits}`;
    const recap = await summarizeProjectRecap(project, digest);
    setProjectRecap(projectId, recap, built.coversAt);
    return recap;
  } finally {
    inFlight.delete(projectId);
  }
}

// Generate recaps for every project that's gone stale with new activity.
// Sequential, best-effort — one bad project never blocks the rest.
export async function sweepRecaps(): Promise<number> {
  let generated = 0;
  for (const p of listProjects()) {
    const st = recapStatus(p as Project);
    if (st.needsRecap && !st.generating) {
      try {
        await generateRecap(p.id);
        generated++;
      } catch {
        // skip — a single failed recap shouldn't abort the sweep
      }
    }
  }
  return generated;
}
