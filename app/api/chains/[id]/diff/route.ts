import { NextResponse } from "next/server";
import { getChain, getProject, listChainSteps } from "@/lib/store";
import { taskDiff } from "@/lib/git";
import { defaultTarget } from "@/lib/chainMerge";
import { jsonGuard } from "@/lib/apiGuard";

export const dynamic = "force-dynamic";

// The chain review's "Combined" tab: the target step's worktree (the last step
// with a branch, or ?through=<taskId>) against the chain's base branch — i.e.
// everything the chain would land that the base doesn't have yet. Same payload
// shape as /api/tasks/[id]/diff so app/TaskChanges.tsx renders it unchanged.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return jsonGuard(`chain diff ${id}`, async () => {
    const chain = getChain(id);
    if (!chain) return NextResponse.json({ error: "not found" }, { status: 404 });
    const project = getProject(chain.project_id);
    if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });
    const steps = listChainSteps(id);
    const through = new URL(req.url).searchParams.get("through");
    const target = through ? steps.find((s) => s.id === through) : defaultTarget(steps);
    if (!target) return NextResponse.json({ error: "that task isn't a step of this chain" }, { status: 400 });
    if (!target.worktree_path)
      return NextResponse.json({ isolated: false, files: [], isDirty: false, ahead: 0, reason: "No step of this chain has a branch yet." });
    const baseBranch = chain.base_branch || project.branch;
    // No diff snapshot: the merge-base with the base branch is exactly "what
    // would land" (after a partial merge it's the last merged step's tip).
    const diff = await taskDiff(project.repo_path, target.worktree_path, "", baseBranch);
    return NextResponse.json({ isolated: true, branch: target.work_branch, ...diff });
  });
}
