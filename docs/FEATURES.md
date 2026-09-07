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

Agents can also suggest follow-up tasks while they work. Every suggestion records which
task proposed it — and which of that task's sessions (its `/clear` generation) — so the
tray groups them under a **From: ‹task› · session N** header instead of one flat pile when
several sessions are planning at once. Suggestions from one planning call stay together
and in the order they were proposed; clicking a header jumps to the task that made them.
Anything with no recorded proposer (suggestions created before this shipped, or whose task
was deleted) collects under **Other**, and a tray where nothing has a proposer shows no
headers at all. The edit dialog for a suggestion repeats its origin as a
"↳ suggested by ‹task›" line that opens the proposer.

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
