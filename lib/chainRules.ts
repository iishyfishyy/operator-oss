// The one "does this blocker still block?" rule, shared by the server
// (lib/autoStart.ts blocks()) and the client (app/orchestrator/format.ts
// blockerTitles()) so the auto-start decision and the "blocked" badge can
// never disagree. Pure — no store/DB imports — because the client bundle
// imports it.
//
//   done / cancelled  terminal: never block (a cancelled blocker will never
//                     finish, so waiting on it would deadlock the dependent).
//   in_review         an auto-advance chain step that called complete_step. It
//                     counts as finished ONLY for a dependent in the SAME
//                     auto-advance chain — that is the stacked chain moving on
//                     without a merge. To anything else it's unmerged, unreviewed
//                     work and still blocks.
//   anything else     blocks.

export interface BlockerLike {
  status: string;
  chain_id?: string | null;
}

export interface DependentLike {
  chain_id?: string | null;
  /** The dependent's chain mode ("auto_review" = auto-advance); null/undefined = no chain. */
  chain_mode?: string | null;
}

export const AUTO_ADVANCE_MODE = "auto_review";

export function depBlocks(dep: BlockerLike, dependent: DependentLike): boolean {
  if (dep.status === "done" || dep.status === "cancelled") return false;
  if (dep.status === "in_review") {
    const sameChain = !!dep.chain_id && dep.chain_id === dependent.chain_id;
    return !(sameChain && dependent.chain_mode === AUTO_ADVANCE_MODE);
  }
  return true;
}

/** What "Continue" on a paused chain step sends: resume, and say how to finish. */
export const CONTINUE_STEP_PROMPT =
  "Continue this step. When — and only when — its work is fully done and verified, call `complete_step` with a short summary so the chain can move on.";
