# Features

Operator is a control room for running coding-agent work across repositories. This page
contains the longer feature inventory kept out of the project README.

## Parallel work without collisions

Each task runs in its own git worktree and branch with an independent Claude Code or Codex
session. Projects and tasks share one workspace, so you can run many sessions without
mixing their files, terminals, or transcripts.

The cross-project **Needs you** signal identifies sessions waiting for input. Turns run on
the server and their events are persisted, so reloading the page or sleeping your laptop
does not lose the transcript. Follow-ups can be queued while a turn is running.

## Context that survives the task

Each project has reusable context that is injected into new tasks. **Refresh with AI** can
redraft that context from the repository, and context injection can be disabled for an
individual project or task when a lean session is preferable.

A task is a lineage of agent sessions. `/clear` summarizes the current conversation and
starts a clean context window with that history, allowing long-running work to continue
without turning into one unbounded prompt.

A session opens with the task itself. The first user message in the transcript is the
task title as a heading followed by its description and a short "Begin working on this
task" line, marked with a small **task** badge, so anyone reading the session can see
what it was asked to do without opening the task. The system prompt still carries the
title and details alongside the project context, dependencies, and carried summaries,
with a note that the two are one request. A task with no description falls back to a
generic "start working on the task" opener. Both the manual Start and the auto-start
pipeline send the same opening turn.

A session that opens **after `/clear`** is not that. Generation 2 and up start with a short
resume turn instead — "you are continuing this task … pick up where it left off" — because
re-sending the day-one kickoff would tell an agent that already has the previous session's
handoff summary in its context to start the task over. The handoff summary has exactly one
home, the system prompt, so the resume turn never repeats it. Anything you type on that
first send after `/clear` rides along with the resume turn rather than being discarded, so
you can steer the new session from its very first message. In the transcript the resume
turn is an ordinary user bubble (no **task** badge) and the session divider under the
`/clear` summary card is labelled **resumed after /clear**.

## Review and delivery

Operator puts the task conversation and git diff side by side. From there you can:

- review every changed file before it reaches the base branch;
- sync a stale task branch;
- merge with one click;
- ask the agent to resolve conflicts; or
- create a GitHub pull request.

Worktrees for merged or finished tasks can be reclaimed from Settings. Discarding unmerged
work requires an explicit permanent-discard confirmation.

## Planning and orchestration

Use a compact list or a full-width kanban board with Suggested, Not started, In progress,
Needs input, and Done states. Tasks can depend on other tasks; **Start when unblocked**
launches an opted-in task as soon as its final blocker is marked done.

Agents can also suggest follow-up tasks while they work — but they ask first. When an agent
notices out-of-scope follow-up work, it lists what it would propose in the chat and waits for
your go-ahead before anything lands in the tray; asking an agent to plan, break down, scope or
roadmap work still fills the tray straight away, since that's what you asked for. Settings →
General → **Suggested tasks** switches this between **Ask me first** (default) and **Add them
automatically**, the old always-proactive behaviour.

Every suggestion records which
task proposed it — and which of that task's sessions (its `/clear` generation) — so the
tray groups them under one header per source — a **From ‹task›** link carrying that task's
live status dot, over a summary bar ("3 follow-ups · session 2 · 2h ago") — instead of one
flat pile when several sessions are planning at once. The tray sits above the task list and
folds to a single line ("2 sources · 1 stale"); the fold is remembered per project.
Bracket prefixes agents put on titles (`[AO][Med] …`) are lifted into a tag chip and a
priority pill, so rows read as plain English. Suggestions from one planning call stay together
and in the order they were proposed; clicking a header jumps to the task that made them.
Suggestions whose proposer was deleted collect under **From a deleted task**; ones that
never recorded a proposer (created before this shipped) collect under **Other**. The edit
dialog for a suggestion repeats its origin as a "↳ suggested by ‹task›" line that opens
the proposer.

### Accepting and starting a suggested chain

Both the list tray and board group suggestions by proposing task and session, then
join groups connected by dependencies between suggestions. Search shows the whole
matching group. When members depend on each other, rows are numbered along a dashed rail,
blockers before dependents; a "← Blocked by" line names blockers outside the group. Groups
longer than six rows show five and a "+ N more" with title previews. Per-row actions (edit,
dismiss, Add, Start) appear on hover; a one-suggestion group offers Dismiss / Add to list /
Start on its header instead.

Group actions are ranked by intent: **Start chain** (primary), **Accept all** (moves the
whole group into your task list in one transaction), **Dismiss all** (quiet).

**Start chain** never fires blind — it opens an inline composer on the group: tick which
members to include, drag rows (or Alt+↑/↓ on the grip) to set the order, pick one agent for
the whole chain, and choose when each next task starts — **Done** (after the previous task
is marked done; merging marks it done), **Auto-advance** (see below) or **Immediately** (all in
parallel). Launching
writes the order as ordinary dependency edges — each selected task's in-group edges are
replaced by a link to the one before it (none for Immediately), edges to tasks outside the
group are kept — then accepts the batch with auto-start on every member with unfinished
blockers and starts each ready root in its own worktree through the normal turn-slot guard.
**Add N to list only** applies the same order without starting anything. Unselected members
stay in the tray. A step that needs input isn't done, so the chain pauses there.
More than three roots requires confirmation before acceptance. Dependents start
when their last blocker is marked done; completing an agent turn alone does not
mark a task done. A group with no ready roots waits for its external blockers.

`POST /api/tasks/accept-batch` accepts `{ ids, start_chain?: boolean,
confirmed_roots?: boolean, chain_mode?: "auto_review" }` and returns fresh `tasks`, `root_ids`, and
`confirmation_required`. Missing, changed, or cross-project members reject the
entire batch. Acceptance is atomic; root launches are separate requests, so a
failed launch remains accepted and can be retried from the task's session.

### Auto-advance chains (review at end)

The composer's **Auto-advance** mode ("Auto-advance, review at end") runs a chain without
you merging and marking done after every step. Accepting creates a chain (`chains` table:
mode `auto_review`, the project's base branch) and stamps each member with its
`chain_id` / `chain_pos`; every step after the first gets auto-start.

- **The agent says when a step is finished.** Chain steps — and only chain steps — get a
  `complete_step(summary)` orchestrator tool and a system-prompt paragraph telling them to
  call it once, at the end, when the work is done and verified. The summary is saved on the
  task (`step_summary`). Other tasks never see the tool.
- **Safety checks at turn end.** The runner advances only if `complete_step` was called
  during *that* turn, the turn ended cleanly (no error — context overflow, dead login,
  approval block, usage limit — not Stopped, no `/clear` mid-turn), no question is still
  open, and no follow-up is queued. Anything else pauses the chain: the step stays
  `in_progress` with awaiting input set, so it shows up in "N need you". The reason is saved
  on the step (`step_pause`: waiting on your answer / the turn hit an error / ended without
  calling `complete_step` / stopped), and the chain card shows it with **Jump to step** and,
  unless the step is waiting on an answer, **Continue** (a resume turn asking the agent to
  finish and call `complete_step`).
- **Resuming picks auto-advance back up.** A `complete_step` call only counts for the turn
  it's made in, so answering, pressing Continue, or sending any follow-up runs a new turn.
  When that turn calls it and ends cleanly, the chain advances as usual. The system prompt
  tells the agent to call it again after a follow-up.
- **Stacked worktrees, base branch untouched.** A finished step's worktree is committed on
  its own branch and the step moves to **In review**. The next step's worktree branches from
  the previous step's branch, and its diff base is the previous step's last commit — so each
  step's Changes tab shows only that step's work, while the step itself builds on everything
  before it. Nothing is merged; you review and merge the stack at the end.
- **In review** unblocks only the next step of the *same* auto-advance chain. To any other
  dependent, an in-review task is unfinished work and still blocks. Setting a chain step to
  In review by hand advances the chain the same way.

Deleting a chain's last task removes the chain row; everything is a hard delete. Deleting a
step **mid-chain** keeps the chain going: the next step (if it hasn't started) is re-linked
to the nearest step before the gap, stacks on that step's branch, and starts right away if
that step has already finished. If a later step had *already* stacked on the deleted one,
its branch still carries the deleted work. The review flags it, and merging is refused
until you **Rebase stack** (which replays each step from its own base, dropping the deleted
step's commits) or discard from that step. `/clear` on a finished (In review) step keeps it
In review. Later steps are stacked on it, so the fresh context is only for follow-ups.

### Chain review (merge the whole stack at once)

Once any step of an auto-advance chain reaches **In review**, the tasks column shows a
**Chains to review** card: a segment per step (done / in review / running / paused /
not started) and a one-line progress label. It's derived from the task rows the
`/api/events` stream already keeps live, so it updates without polling, and it stays
until every step is done or cancelled. **Review chain** opens the review in the session
pane:

- **Steps** — each step in order with its title, status, `complete_step` summary, and +/−
  lines. Expanding a step shows its own diff (the regular Changes viewer, read-only): its
  diff base is the step's `base_sha`, the previous step's last commit, so it shows only
  that step's work. **Open** jumps to the step's session.
- **Combined** — the last step's branch against the chain's base branch: everything the
  chain would land.
- **Merge chain** merges the last step's branch — which contains every step — into the
  chain's base branch with **one** merge commit, then marks every step merged and
  **done** and records one Insights row per step with that step's own line counts (read
  before the merge, since worktrees don't outlive their tasks). Steps turning done
  auto-start any dependents outside the chain, as a manual Done would.
- **Merge up to here** (per step) merges that step's branch and marks steps 1..k done.
  **Later steps keep their stack**: nothing is rebased. Step k+1 still descends from step
  k's tip, which is now in the base branch, so its diff still shows only its own work and
  merging it later lands just the remaining commits. (Rebasing would rewrite branches
  under live worktrees and agent sessions for no gain.)
- Merging is refused while **any** step of the chain is running, when a step in range
  hasn't run yet or was cancelled, and when the stack is broken: an earlier step got more
  commits (or has uncommitted edits) after the next step branched from it, so landing the
  last branch would silently drop that work. The error names the step; merge up to it
  first.
- **Conflicts** use the existing AI flow on the target step's worktree: **Fix with AI**
  trial-merges the base branch into it (`prepareWorktreeMerge`) and streams the
  resolution prompt as a turn on that step (a clean trial merge just lands). When the turn
  finishes, **Accept & merge chain** completes the staged merge and lands every step;
  **Discard resolution** aborts it. Resolving by hand in the step's terminal works too.

- **Send back** (header) opens a feedback box with an optional **About** step. The
  feedback runs as a **fix-up turn on the last unmerged step**. Its worktree already
  contains every step, so nothing is rebased. The prompt names the step the feedback is
  about, with that step's `complete_step` summary. It goes through the normal resume path,
  so you can watch it in that step's session. When the fix-up calls `complete_step`, it is
  committed as its own `Fix-up: …` commit and the chain is back in review. If it pauses
  instead, answer it in the session or press **Back to review** (the same as setting the
  step to In review by hand). Fix-ups appear as trailing **Fix-up** entries under the
  steps, each with its feedback, summary, state, and its own +/− lines (from the last
  step's HEAD when it started). A fix-up's summary is stored on the fix-up, so the step's
  own summary is kept. Only one fix-up can be open at a time.
- **Discard from here** (per unmerged step; **Discard** on the last one) asks for
  confirmation, then hard-deletes that step and every step after it. Their turns are
  stopped and their worktrees **and branches** are removed. Earlier steps stay reviewable
  and mergeable. A range that holds a merged step is refused.
- **Base branch moved.** When the chain's base branch has commits the stack doesn't, a
  banner shows how far behind the stack is (and any predicted merge conflicts). It offers
  **Rebase stack onto <base>**, which replays every unmerged step in order (`git rebase
  --onto`, each step onto the rebased tip of the one before, starting from its own
  `base_sha`) and moves each `base_sha` forward so per-step diffs still show only that
  step's work. The rebase is all or nothing: a conflict resets every step already
  rebased, names the conflicting step, and points you to merging with **Fix with AI**.
  Every step must be idle and committed first. A step whose branch contains a merge
  commit (for example, a manual Sync with the base) is refused. A rebase would drop the
  merge, and any edits made inside it would silently disappear, so merge the chain instead. You can also just merge without rebasing,
  since the merge handles a moved base.

A chain that has finished every step (at least one In review, the rest In review, done,
or cancelled, nothing running) **counts once in "N need you"** and in the project badge.
The server's `awaiting_count` includes it, so it arrives on the `/api/events` stream like
any task's count. It is also listed in the need-you dropdown as "Review chain: …", and
picking it opens the review. The card says **Ready for review**. A paused step is counted
as itself, never twice.

API: `GET /api/chains/[id]` (steps + stats + per-step merge eligibility + any staged
resolution + fix-ups + Send-back eligibility + base-moved state + stack warnings),
`POST /api/chains/[id]/send-back` with `{ feedback, about?: taskId }`,
`POST /api/chains/[id]/discard` with `{ from: taskId }`, `POST /api/chains/[id]/rebase`, `GET /api/chains/[id]/diff[?through=taskId]` (the Combined diff, same shape
as the task diff route), `POST /api/chains/[id]/merge` with `{ through?: taskId }`, and
`POST /api/chains/[id]/merge/prepare` with the same body (the conflict path). All under
the normal middleware auth.

### Curating suggestions from the session that proposed them

The link runs the other way too. In the proposing task's transcript, every `suggest_task`
call is a live **suggestion chip** rather than a frozen tool line: it shows the task's
*current* title (a rename made in the tray or the edit dialog shows here as well), and it
carries the tray's own controls — click the title to rename it inline (Enter saves, Esc
cancels), the pencil opens the full edit dialog, and **Add** / **Start** / **Dismiss** do
exactly what they do in the tray. Once a suggestion has been added or started the chip
shows its status and an **Open** that jumps to it; a dismissed one stays in the transcript
greyed out and marked **dismissed**, so the record of what was proposed survives the
decision.

A turn that files two or more suggestions also gets a **Suggested this session** block after
its last message: one collapsible unit listing all of that turn's chips, so a planning turn
that proposed five tasks can have its titles fixed in one place instead of five cards
scattered among the tool calls that produced them.

### New vs stale suggestions

A tray only grows, so each group also says how fresh it is. The header carries the age of
its newest member ("just now", "2h", "3d") and groups sort newest-first, so whatever just
landed reads first.

Suggestions that arrived since you last looked at that project's tray get a **new** pill,
and the tray header counts them ("4 new"). Seeing the tray — expanding it or scrolling it
into view — advances the mark, so next visit those aren't new any more; the pills you're
currently looking at stay put until you leave the project and come back. The mark is per
project and lives in the browser, not the database: it's a read marker, so losing it costs
one round of stale pills, and it never costs a server round trip.

A group goes **stale** when its proposer is done, cancelled (merging a task marks it done)
or deleted, or when nothing has been added to it in over a week. Stale groups render
collapsed behind an amber **Stale** tag (hover it for why), and the tray header offers
**Dismiss stale** for all of them at once.

Every dismissal from the tray — one row, a group, or all stale groups — is instant, with an
**Undo** toast for six seconds. Deletes are still hard deletes: the rows are only hidden
during that window and the delete goes out when it closes (or immediately, as a keepalive
request, if you close the tab), so Undo never has to resurrect anything. The list column and the board's
Suggested column render the same groups from the same component, so they always agree.

Project recaps help restore your mental context when you return later.

## Workspace tools

The integrated terminal provides a real shell for each project. It opens in the project's
working directory; a Project/Task toggle in its bar switches the shell into the selected
task's git worktree, so you can run tests or poke at a task's changes before merging.
Managed `dev`, `setup`, and `test` services keep running after an agent turn or browser tab
ends, with live logs and stable per-project ports. Optional service hostnames can expose
previews with private, shared-link, or public visibility.

See [Managed services](SERVICES.md) for setup and security details.

## Transparent usage

Every task reports tokens and usage. The Insights dashboard breaks activity down by day,
project, and agent, while keeping Operator's background work separate from task usage.
Subscription users see an API-price equivalent for context—not a bill.

See [Insights and usage](INSIGHTS.md) for how to read the numbers.

## Agent connections

Claude Code and Codex are first-class agent drivers. Operator detects expired connections,
preserves queued follow-ups, and provides a reconnect action. Background jobs choose a
connected agent automatically, so a Claude-only or Codex-only installation works without
special configuration.

See [Supported agents](AGENTS.md) for capabilities and upstream limitations.
