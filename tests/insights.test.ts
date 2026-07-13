import { describe, expect, it } from "vitest";
import { ensureWorktree, mergeTask } from "../lib/git";
import {
  addUsage,
  createProject,
  createTask,
  getInsightsData,
  recordTaskMerge,
  updateTask,
} from "../lib/store";
import { commitFile, makeRepoWithWorktree, tmpDir, writeFile } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;
const usage = (over: Partial<Parameters<typeof addUsage>[0]["usage"]> = {}) => ({
  cost_usd: 1.5, input_tokens: 100, output_tokens: 50, cache_read_tokens: 1000, cache_creation_tokens: 200,
  ...over,
});

function makeProjectTask(agent = "claude") {
  const project = createProject({ name: `p-${Math.random().toString(36).slice(2, 8)}`, repo_path: tmpDir() });
  const task = createTask({ project_id: project.id, title: "t", description: "", agent });
  return { project, task };
}

describe("merge line stats", () => {
  it("mergeTask reports the additions/deletions the merge landed", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "a.txt", "one\ntwo\nthree\n", "add a");
    writeFile(wt.path, "b.txt", "x\n"); // uncommitted — committed by mergeTask

    const res = await mergeTask({
      repoPath: repo, worktreePath: wt.path, workBranch: wt.branch,
      baseBranch: "main", message: "land",
    });

    expect(res.ok).toBe(true);
    expect(res.additions).toBe(4); // 3 lines in a.txt + 1 in b.txt
    expect(res.deletions).toBe(0);
  });

  it("omits stats when there was nothing to land", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    const res = await mergeTask({
      repoPath: repo, worktreePath: wt.path, workBranch: wt.branch,
      baseBranch: "main", message: "noop",
    });
    expect(res.ok).toBe(true);
    expect(res.alreadyMerged).toBe(true);
    expect(res.additions).toBeUndefined();
  });
});

describe("getInsightsData", () => {
  it("buckets usage by local day and stamps the agent", () => {
    const { project, task } = makeProjectTask();
    addUsage({ project_id: project.id, task_id: task.id, generation: 1, agent: "claude", usage: usage() });
    addUsage({ project_id: project.id, task_id: task.id, generation: 1, agent: "codex", usage: usage({ cost_usd: 0.5 }) });

    const data = getInsightsData(Date.now() - DAY);
    const mine = data.usage.filter((u) => u.p === project.id);
    expect(mine).toHaveLength(2); // grouped by (day, project, agent)
    const claude = mine.find((u) => u.a === "claude")!;
    expect(claude.cost).toBeCloseTo(1.5);
    expect(claude.inp).toBe(100);
    expect(claude.cr).toBe(1000);
    expect(mine.find((u) => u.a === "codex")!.cost).toBeCloseTo(0.5);
    // local-day key, not UTC: matches what the client generates from new Date()
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    expect(claude.d).toBe(key);
  });

  it("aggregates merges and shipped tasks, and honors the since cutoff", () => {
    const { project, task } = makeProjectTask("codex");
    updateTask(task.id, { merged_at: Date.now() });
    recordTaskMerge({ project_id: project.id, task_id: task.id, agent: "codex", additions: 120, deletions: 30 });
    recordTaskMerge({ project_id: project.id, task_id: task.id, agent: "codex", additions: 10, deletions: 5 });

    const data = getInsightsData(Date.now() - DAY);
    const m = data.merges.filter((r) => r.p === project.id);
    expect(m).toHaveLength(1); // same day+agent → one grouped row
    expect(m[0].add).toBe(130);
    expect(m[0].del).toBe(35);
    expect(m[0].a).toBe("codex");
    const s = data.shipped.filter((r) => r.p === project.id);
    expect(s).toHaveLength(1);
    expect(s[0].n).toBe(1);

    // a cutoff in the future excludes everything
    const later = getInsightsData(Date.now() + DAY);
    expect(later.merges.filter((r) => r.p === project.id)).toHaveLength(0);
    expect(later.shipped.filter((r) => r.p === project.id)).toHaveLength(0);
  });
});
