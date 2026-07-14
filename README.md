<div align="center">

# Orchestrator

### Run many Claude Code sessions in parallel — across every project — from one screen.

Stop juggling terminals. Each **project** carries reusable context; each **task** is its own Claude Code session in its own git worktree. Drive ten in parallel, see exactly which one needs you, and review every diff before it merges.

Built on the **Claude Agent SDK**, driven by your **local Max/Pro login — no API key, no per-token billing.**

![Orchestrator workspace](docs/images/workspace.png)

</div>

---

## Why

You're paying for a 100×/200× Claude plan. The bottleneck isn't the model — it's *you*, tabbing between terminals, re-explaining context, and losing track of what's running where.

Orchestrator removes that bottleneck:

- **Finally hit your plan's limits.** Run many sessions at once and make product decisions in parallel instead of one terminal at a time.
- **One screen for everything.** Every project and every task in a three-column workspace — no more "which terminal was that?"
- **Never repeat yourself.** Project context is written once and injected into every task; `/clear` hands a summary forward to the next session automatically.
- **Know exactly who needs you.** A live "needs your input" signal across *all* projects tells you which session is waiting — so parallel never means chaos.
- **Ship safely.** Each task runs in an isolated git worktree; review the diff and merge with one click (Claude resolves conflicts if they appear).

## Features

| | |
|-|-|
| 🚀 **Guided first-run setup** | A brand-new instance opens a wizard: connect Claude (in-UI sign-in with your Pro/Max account — authorize link + paste-code surfaced, no terminal — or an API key), then verify with a one-shot test turn. State persists (resumes if abandoned), is skippable, and re-runnable from **Settings → Setup**. |
| 🔌 **Connect more agents** | Claude is the required default (it runs the app's own jobs), but you can add other coding agents the same no-API-key way. **Settings → Agents** connects **Codex** with your ChatGPT-plan login (device-auth: open a link, enter a one-time code — or an OpenAI API key), verifies it with a real test turn, and remembers which agents are connected so task creation can offer only the ready ones. A dismissible post-setup nudge points the way. |
| 🎓 **Built-in tutorial** | Instead of asking you to configure a project up front, setup drops you into a seeded **Welcome** project backed by a real (tiny) repo. One ready task — *"Try me: add a tagline"* — walks the whole loop: streaming tool calls, an AskUserQuestion card, a one-file diff, a one-click merge. A second Claude-proposed task waits in the **Suggested** tray. Coach marks explain the three-column loop; merging the tutorial nudges you to create your own project. Delete it any time — it never re-seeds. |
| 🗂 **Projects → tasks, one screen** | A dark "mission-control" workspace: projects rail · task list · live session, with the live session split between the transcript and a **DIFF / PREVIEW / CONTEXT** rail. Switch instantly; streams keep running in the background. Ships dark (default) + light themes. |
| ⚡ **True parallel sessions** | Every task is its own agent session. Run as many as your plan allows — each shows a pulsing live dot. |
| 🔀 **Pick your agent per task** | Each task runs on **Claude Code** or **Codex** — chosen at creation (defaulting to the project's default agent, then the app default) and fixed for the task's life, since a session can't migrate between CLIs. The model / reasoning / permission pickers, context-window gauge, and cost display are all driven by the selected agent's capabilities, so the controls always match the agent — Codex shows its GPT-5.x models and hides the dollar figure its ChatGPT-plan auth doesn't report. A per-task agent badge labels each task; project & app settings carry per-agent run defaults. |
| 🔌 **Reconnect-safe turns** | Turns run server-side, detached from the browser. Hard-reload, sleep the laptop, or drop the connection mid-turn — the turn keeps running and the transcript catches up live on reconnect. Multiple viewers of one task all stream the same events. |
| ⏩ **Queue follow-ups mid-turn** | Don't wait for a turn to finish — type your next message while Claude is still working and it parks as a **queued** bubble. When the turn ends, queued follow-ups run automatically, in order, as the next turns. Cancel any one before it runs; **Stop** discards the queue. Built for driving many sessions at once. |
| 🧠 **Write-once project context** | Per-project "what we're building" is auto-prepended to every task's prompt. Stop re-explaining your stack. As the codebase outgrows its original description, hit **Refresh with AI** in the Context editor — Claude reads the repo and drafts fresh context (stack, layout, conventions, key paths) for you to review and save. |
| 🔗 **Session lineage / `/clear`** | `/clear` summarizes the transcript and seeds a fresh context window with it. The task lives on across generations — context carried, window reset. If a turn ever overflows the model's context ("Prompt is too long"), the transcript surfaces a one-click **Start fresh context** button wired straight to `/clear`, so a poisoned session recovers instead of failing forever. |
| 🔴 **"Needs your input," everywhere** | When a turn ends mid-task: a coral alert dot, a top task group, a per-project badge, and a cross-project **"N NEED YOU"** pill in the title bar (click to jump). |
| 💬 **Answer Claude's questions** | When Claude calls `AskUserQuestion`, the options surface as an inline card (single/multi-select + a free-text "Other"); your pick is fed back as the tool result and the session continues. |
| 🖼️ **Image & large-paste attachments** | Drag & drop, paste, or pick images (PNG/JPEG/GIF/WebP, 10 MB each) into the chat. They upload outside the worktree (never in your diff), render as thumbnails in the transcript, and Claude views them with its Read tool — screenshots of bugs, mockups to build, designs to match. A very large text paste (over ~100 KB) is diverted the same way — saved as a file attachment and read on demand — instead of being inlined, so a giant paste can't blow past the context limit. |
| 🌿 **Worktree isolation + diff review** | Each task gets its own git worktree and branch. Review the full diff vs base, then **one-click merge** into your base branch. |
| 🤖 **AI merge-conflict resolution** | If a merge conflicts, **Fix with AI** runs a Claude turn (streamed into the transcript) to resolve the markers — you review and **Accept** or **Discard**. |
| 🔀 **Create a GitHub PR** | Prefer review on GitHub to a local merge? **Create PR** (in the DIFF toolbar) pushes the task's branch to `origin` and opens a pull request via `gh pr create`, title/body prefilled from the task (plus the latest session summary). The PR link sticks to the task — a clickable chip in the chat header — and the button becomes **Update PR**, pushing new commits to the same PR. Needs the `gh` CLI logged in and an `origin` remote; anything missing surfaces as a clear message, never a hang. |
| 🔄 **Sync stale tasks to main** | Reopen an old task and it shows how far its branch is behind base. Fast-forwardable branches catch up silently on your next message; branches with work get a one-click **Sync** (or **Fix with AI** when the merge would conflict). |
| 🧹 **Prune merged worktrees** | **Settings → Storage** lists merged tasks whose worktrees are still eating disk (with a "merged more than N days ago" filter and the space each reclaims), multi-select + confirm to remove them. Branches are **kept by default** (so you can still reopen the task — its worktree is recreated on demand); deleting them is an explicit opt-in. |
| 💸 **Token & cost tracking** | Each task's chat header shows its cumulative tokens + dollar spend, updating live after every turn; the projects rail rolls up a per-project total. |
| 📊 **Insights dashboard** | A full-screen analytics view (bar-chart button in the top bar, `⌘K → Open Insights`, or `?view=insights`): daily spend and tokens (stacked by agent / token category, with an include-cache toggle), tasks shipped and lines merged per day, a by-provider breakdown, and a clickable projects leaderboard with sparklines. Filter by 7/30/90 days, project, and agent — all computed locally from the usage ledger, one fetch per visit. Dollar figures are **API-equivalent cost** (what the usage would have cost on the API), not a bill. Line-merge stats are recorded from this release onward (captured at merge time). |
| ✦ **Claude-suggested tasks** | Claude proposes follow-up work via the `suggest_task` tool; it lands in a Suggested tray to edit, accept, or start. |
| 🔒 **Task ordering / dependencies** | Mark a task as **blocked by** one or more others (cycle-guarded). It shows a "Blocked by" chip and its **Start** is disabled until every blocker is Done — then it becomes startable (it never auto-starts). A Cancelled blocker stops blocking: it will never finish, so it can't hold a dependent hostage. |
| 🐙 **Connect GitHub & clone** | Guided `gh` device-flow login from the UI (the one-time code + link surface in the app, no terminal needed), then **New project → Clone from GitHub** picks from your repos — private ones included — clones it, and points the project at the checkout. The login persists across restarts. |
| 🖥 **Integrated terminal** | A real shell (xterm + node-pty) rooted in the project's working dir, in a bottom drawer — no separate window. The project's deterministic `PORT` is injected into the shell. |
| 🔌 **Supervised dev servers** | Configure per-project `dev` / `setup` / `test` commands in the project context; the orchestrator runs them as long-lived child processes (start/stop/restart, status dot, live logs) that **outlive the Claude turn and the browser tab**. Each project gets a stable `PORT` injected into the service env. Claude can register a server it just started via the `expose_service` MCP tool and get back a working URL. |
| 📌 **"Where you left off" recaps** | Return to an idle project and Claude shows a short recap of what was last done, from task summaries + recent commits. |
| ⏹ **Stop a running turn** | Interrupt a streaming session cleanly; the partial transcript stays and the task is resumable. |
| 🚫 **Cancel a task** | Mark an abandoned task **Cancelled**: any in-flight turn is stopped, queued follow-ups are discarded, and it drops into a collapsed Cancelled group at the bottom of the task list. Unlike Delete, the transcript, diff, and worktree are kept — send another message and the task revives. |
| 🎛 **Built-in niceties** | Project reorder, deprecate/restore, session history, dark/light + accent + density tweaks, full markdown + syntax-highlighted transcripts with green/red colored diffs for every Edit/Write. |

### Live session

Chat with Claude on the right, watch tool calls stream in, drive the task to done.

![Session transcript](docs/images/session.png)

### Review the diff, then merge

The **DIFF** tab of the session rail shows a full diff of the task's branch vs base, side by side with the transcript — review every line, then **Merge** with one click (or let AI resolve conflicts). Prefer to review on GitHub instead? **Create PR** pushes the branch and opens a pull request (see the features table). (On mobile, flip to the **Changes** view.) Collapse the whole rail to a slim spine (▸ on its header) when you want the full width for the transcript — like minimizing the projects or tasks column, the choice sticks across reloads.

![Diff review and merge](docs/images/changes.png)

### Integrated terminal — no extra window

A real shell rooted in the project's working dir, in a bottom drawer. If the shell exits (or the connection drops), press **Enter** to spawn a new one, or use the restart button in the drawer bar.

![Integrated terminal](docs/images/terminal.png)

## How it compares

Orchestrator is purpose-built around **Claude Code + your subscription**, and optimizes for the two things that actually slow down parallel agent work: **context continuity** and **knowing which session needs you**.

| Capability | **Orchestrator** | Vibe Kanban | Plain Claude Code |
|-|-|-|-|
| Parallel sessions, isolated git worktrees | ✅ | ✅ | ❌ (manual) |
| Review diff before merge | ✅ | ✅ | ❌ |
| **Many projects on one screen** | ✅ | ➖ per-project | ❌ |
| **Reusable project context auto-injected** | ✅ | ❌ | ❌ |
| **Session lineage — `/clear` carries a summary forward** | ✅ | ❌ | ❌ |
| **Cross-project "needs your input" signal** | ✅ | ❌ | ❌ |
| **AI merge-conflict resolution** | ✅ | ❌ | ❌ |
| **"Where you left off" recaps** | ✅ | ❌ | ❌ |
| Claude-suggested next tasks | ✅ | ❌ | ❌ |
| Integrated terminal per project | ✅ | ➖ | n/a |
| Runs on your Max/Pro login, no API key | ✅ | depends on agent | ✅ |
| Multi-agent executors (Claude Code · Codex; Gemini / Cursor 🛣) | ✅ per-task picker | ✅ | ❌ |
| Kanban board view · GitHub PR creation | 🛣 roadmap | ✅ | ❌ |

<sub>Comparison reflects Vibe Kanban as of mid-2026 ([now community-maintained](https://github.com/BloopAI/vibe-kanban)). Orchestrator trades multi-agent breadth for deep Claude Code integration and context continuity.</sub>

## Quick start

```bash
npm install
npm run dev      # starts the web app (:3000) AND the node-pty sidecar (127.0.0.1:3001)
# open http://localhost:3000
```

App data lives **outside the repo**: first run creates `~/.zen-orchestrator`
(SQLite) and `~/.agent-orchestrator/worktrees` (per-task git worktrees) —
relocatable via `ORCH_DB_DIR` / `ORCH_WORKTREES_DIR`. Ports 3000/3001 taken?
`PORT=3100 PTY_PORT=3101 npm run dev`.

**First run — guided setup.** A brand-new instance opens a **setup wizard** trimmed to the
two irreducible steps: connect Claude (sign in with your Pro/Max account right in the UI —
the authorize link and paste-code field are surfaced for you, no terminal required — or
paste an API key instead) and verify the connection with a one-shot test turn (*Connected
as … (Max)*). Setup state persists, so an abandoned wizard resumes at the right step; it's
skippable for power users and re-runnable any time from **Settings → Setup**.

**Then a 2-minute tutorial.** Rather than asking you to configure a project before you've
seen anything work, the wizard lands you on a seeded **Welcome** project — a tiny real repo
(the *Aurora* one-page site) with one ready task, *"Try me: add a tagline."* Start it and
you watch the whole loop in your own workspace: streaming tool calls, a question card to
answer, a one-file diff to review, and a one-click merge — after which a nudge offers to set
up your own project. A second, Claude-proposed task sits in the **Suggested** tray so you
discover that flow too. The Welcome project is an ordinary project: dismiss or delete it any
time, and it never comes back once you have real projects.

**Requirements**
- **Node 18.18+** (Node 22 recommended — it's what the Docker image ships).
- The `claude` CLI — install with `npm install -g @anthropic-ai/claude-code` — and a
  **Pro/Max** plan (the wizard signs it in for you; or run `claude auth login` yourself).
  Without it the app still boots, but the setup wizard's "Connect Claude" step will fail
  until it's installed. Works headless too (containers/servers): the CLI prints the OAuth
  URL and accepts a pasted code.
- `ANTHROPIC_API_KEY` **unset** unless you deliberately chose the wizard's API-key path —
  otherwise it takes precedence and bills per-use instead of using your subscription.
- macOS or Linux (the terminal uses `node-pty`).

> Before starting a task, give the project a real **working directory** — Claude operates on that repo and the terminal opens there. The seeded **Welcome** project ships with one scaffolded for you; for your own projects use **New project → Clone from GitHub** (connect once via the guided device-flow login, then pick a repo or paste a URL), or set the directory by hand in the project's **Context** banner.

Other scripts: `npm run dev:next` (web only, no terminal) · `npm run pty` (terminal sidecar only) · `npm run build && npm start` (production).

The browser talks to a **single origin**: `server.js` fronts Next.js and proxies the terminal's WebSocket under `/pty` to the local sidecar. That means a Cloudflare Tunnel (or any reverse proxy) exposing one https hostname carries both the app and the terminal — no second port, and `wss://` is used automatically over https.

## Configuration

Every per-instance value — ports, data paths, public URL, claude binary — is driven by environment variables, so one documented env set fully relocates an instance (fresh container, different user, different ports) with **zero code edits**. See [`.env.example`](.env.example) for the same list in copyable form. Export the variables in the environment that launches `npm run dev` / `npm start` — `server.js` and `pty-server.js` are plain Node and read them before Next boots, so a `.env` file alone doesn't cover `PORT`/`HOSTNAME`/`PTY_*`.

| Variable | Default | What it does |
|-|-|-|
| `PORT` | `3000` | Port of the single public origin (Next.js + `/pty` proxy) |
| `HOSTNAME` | `0.0.0.0` | Bind address of the app server |
| `PTY_PORT` | `3001` | Port of the node-pty terminal sidecar |
| `PTY_HOST` | `127.0.0.1` | Bind address of the sidecar **and** the proxy's upstream. Keep it on loopback — the browser never connects directly; `server.js` proxies `/pty` to it |
| `PUBLIC_BASE_URL` | *(empty)* | The origin users reach the app on (e.g. `https://orch.example.com` behind a tunnel). The client builds its `ws(s)://` terminal URL from it; empty = the browser's own origin, correct for any single-hostname deployment |
| `CF_ACCESS_TEAM_DOMAIN` | *(empty)* | Cloudflare Zero Trust team domain (e.g. `your-team.cloudflareaccess.com`). With `CF_ACCESS_AUD`, turns on origin-side verification of the Cloudflare Access JWT on every route and on the terminal WebSocket — see "Origin-side auth" below |
| `CF_ACCESS_AUD` | *(empty)* | The Access application's `aud` tag the JWT must carry (comma-separable) |
| `SERVICE_TOKEN` | *(empty)* | Shared secret letting health probes read `GET /api/instance/idle` — and only that route — without an Access JWT (`x-service-token` header) |
| `ORCH_DB_DIR` | `~/.zen-orchestrator` | Directory holding `orchestrator.db` (SQLite app data). Absolute path; created on first run |
| `ORCH_WORKTREES_DIR` | `~/.agent-orchestrator/worktrees` | Where per-task git worktrees are created. Must live outside any project repo |
| `ORCH_PROJECTS_DIR` | `~/projects` | Where **Clone from GitHub** puts cloned repos (the new project's working dir points inside it) |
| `ORCH_SERVICE_PORT_BASE` | `4300` | Base of the deterministic per-project port block. Each project is assigned `base + slot` at creation (stored on `projects.port`), injected as `PORT` into its supervised services and PTY. Relocate the block to avoid clashing with the app/sidecar ports |
| `CLAUDE_CLI_PATH` | `~/.local/bin/claude` | Path to the logged-in `claude` CLI (pinned because Next's server may run with a trimmed `PATH`) |
| `POSTHOG_KEY` | *(empty)* | PostHog project API key (`phc_…`). Set = product analytics on: browser snippet (landing + in-app) **and** server-side events. Empty = fully no-op. Safe to expose (write-only ingest key) |
| `POSTHOG_HOST` | `https://us.i.posthog.com` | PostHog ingest host (`https://eu.i.posthog.com` for EU cloud) |
| `ORCH_ACCOUNT_ID` | *(empty)* | The `distinct_id` analytics events are keyed by. Leave empty for a standalone instance (falls back to `self-hosted`) |

### Product analytics (PostHog; optional, off by default)

If you set `POSTHOG_KEY`, the app loads the PostHog browser snippet (`app/layout.tsx`) and emits server-side events (`lib/analytics.ts`, a dependency-free fire-and-forget capture): per-turn cost (`turn_started` / `turn_completed` / `turn_failed`), project/task counts, and retention (`app_opened` / `heartbeat`). With no key set — the default — all of it no-ops and nothing is ever sent anywhere.

Example — relocate an instance entirely via env:

```bash
PORT=8080 PTY_PORT=8081 \
PUBLIC_BASE_URL=https://orch.example.com \
ORCH_DB_DIR=/data/orchestrator \
ORCH_WORKTREES_DIR=/data/worktrees \
CLAUDE_CLI_PATH=/usr/local/bin/claude \
npm start
```

## Running it in Docker (self-host)

The [`Dockerfile`](Dockerfile) builds a single-user image: a **production**
Next.js build (so a stopped container starts in seconds) bundling Node 22, git,
and the `claude` CLI, with [`docker/entrypoint.sh`](docker/entrypoint.sh)
running both processes (app server + pty sidecar) under tini. All state lives
under `/home/orch` — one named volume captures the SQLite db, worktrees,
project repos, and claude login. [`docker-compose.yml`](docker-compose.yml) is
the parameterized runner:

```bash
docker build -t agent-orchestrator .
ORCH_USER=alice ORCH_PORT=10001 ORCH_RUNTIME=runc \
  docker compose -p orch-alice up -d
# open http://127.0.0.1:10001
```

The container publishes its port on the **host's loopback only**. If you want
to reach it from elsewhere, put an authenticated tunnel or reverse proxy in
front — this app hands out a full shell and a `bypassPermissions` agent, so
never expose the port raw.

**Origin-side auth (optional)** — if you front an instance with Cloudflare
Access, set `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` and the origin
re-verifies the Access JWT (`Cf-Access-Jwt-Assertion` header /
`CF_Authorization` cookie, checked against the team's public signing keys and
the app's `aud` tag) on **every HTTP route** (Next.js middleware) **and on
every WebSocket upgrade** (`server.js`, in front of the `/pty` terminal proxy).
No valid assertion → 403. [`lib/cf-access.mjs`](lib/cf-access.mjs) is the
single shared verifier; the titlebar shows the authenticated email. Unset (the
local default), the app runs open — fine on your own machine, not on a public
port. The one exception is `SERVICE_TOKEN` for the idle/health endpoint, above.

**Idle signal** — `GET /api/instance/idle` reports whether the instance can be
safely stopped: live turn count, open transcript SSE streams, open terminal
WebSockets, awaiting-input tasks, and the last-request timestamp. Polling it
does not itself count as activity, and the image uses it as its `HEALTHCHECK`.
An external supervisor can consume it to stop/start idle containers.

## Hosted version

Don't want to run a server? **[getoperator.dev](https://getoperator.dev)** is
the hosted version of this app: sign up and get your own always-on, hardened
instance (gVisor-isolated container, Cloudflare-tunneled hostname, sleep/wake
economics) — works from your phone, survives your laptop closing, zero setup.
It runs this same codebase plus a closed-source provisioning/billing control
plane.

## How it works

**A task is a lineage of sessions.** Generation N ends at `/clear`; its transcript is condensed to a summary, and generation N+1 starts with a clean context window seeded by all prior summaries. The task persists — only the context window resets. No repeating yourself across a long-running effort.

**Where data lives**

| What | Where |
|-|-|
| Projects, tasks, transcripts, summaries, session index | `orchestrator.db` (SQLite) in `ORCH_DB_DIR`, default `~/.zen-orchestrator` |
| Per-task git worktrees | `ORCH_WORKTREES_DIR`, default `~/.agent-orchestrator/worktrees` |
| Your apps' actual code | each project's working directory — never the orchestrator |
| Claude Code's raw session logs | `~/.claude/projects/...` (managed by Claude Code) |

**Stack:** Next.js (App Router) + TypeScript · React 19 · better-sqlite3 · `@anthropic-ai/claude-agent-sdk` · xterm.js + node-pty sidecar · streaming over SSE.

<details>
<summary><b>Architecture map</b></summary>

- **`lib/db.ts`** — SQLite schema, migrations, seed.
- **`lib/store.ts`** — typed queries for projects / tasks / messages / summaries / sessions.
- **`lib/agents/`** — the pluggable agent-driver seam. `types.ts` defines the `AgentDriver` interface (a normalized `StreamEvent` turn contract, one-shot summarize/draft/recap helpers, a capability descriptor, and the login/verify auth surface); `registry.ts` resolves a driver by id (`getDriver(task.agent)` — persisted per task, defaulted per project via `projects.default_agent`); `shared.ts` holds the agent-agnostic pieces every driver reuses (project-context + conflict prompts, tool-call → title/peek/diff normalizers, the event queue). `GET /api/agents` serves each driver's capability descriptor **plus its persisted connection state** to the client, which renders every run-control picker (model / reasoning / permission), the per-task agent picker, agent badges, and the cost/ask feature gates from that data — no hardcoded per-agent lists in the UI. Connecting an agent is driver-driven and route-generic: **`/api/agents/[id]/{login,login/code,verify,api-key,status}`** resolve `getDriverStrict(id)` and call its auth surface, so a new agent costs zero new routes; `connections.ts` records which agents are connected (settings keys scoped by agent id) so the UI can gate on it. Each agent's credentials live under `$HOME` (Claude `~/.claude`, Codex `~/.codex`); the optional per-token API-key paths persist to a 0600 file (`lib/anthropic-key.ts` / `lib/openai-key.ts`).
- **`lib/agents/claude/driver.ts`** — the Claude Code driver: `runTurn()` via the Agent SDK (resume or fresh session, project context appended to the Claude Code system prompt), the `suggest_task` + `expose_service` MCP tools, `summarizeTranscript()` for `/clear`, and `draftProjectContext()` (read-only agent loop that explores the repo to refresh a project's saved context). Auth delegates to `lib/claude-auth.ts`.
- **`lib/agents/codex/driver.ts`** — the OpenAI Codex driver, driven by the user's ChatGPT-plan `codex` login (no API key). Built on `@openai/codex-sdk` (it spawns the `codex` CLI and speaks JSONL over stdio, same architecture as the Claude driver): `startThread()` / `resumeThread(session_id)`, with the codex thread id emitted as the `session` event so lineage/resume works unchanged. `events.ts` normalizes codex's `ThreadItem` stream (agent_message → assistant, command_execution / file_change / mcp_tool_call / web_search / todo_list / reasoning → tool + tool_result, `turn.completed` usage → tokens with `cost_usd 0`) into the `StreamEvent` contract. Run controls map our permission modes to codex's sandbox/approval policy (bypassPermissions → workspace-write + approvals-never; plan → read-only); reasoning presets map to `model_reasoning_effort`. Capabilities declare `supportsMcpTools:true` (the orchestrator's `suggest_task` / `expose_service` reach codex through the portable stdio MCP bridge, registered per turn as an `mcp_servers` config override — see below), `supportsAsks:false` (codex non-interactive mode has no interactive-ask hook yet) and `reportsCostUsd:false` (ChatGPT-plan auth reports no dollar cost). Auth (`auth.ts`) drives `codex login --device-auth` + `codex login status`. The one-shot helpers (`summarizeTranscript` / `draftProjectContext` / `summarizeProjectRecap`) run as `codex exec` one-shots in a **read-only sandbox** (no writes, no approvals, no network — the guardrail for pure summarization and read-only repo exploration alike). Binary via `CODEX_CLI_PATH` (else the SDK auto-resolves its bundled binary / PATH).
- **`lib/agents/oneshots.ts`** — routing for the *internal* jobs that run a turn **outside the main chat**: `/clear` handoff summaries, project recaps, and "Refresh with AI" context drafts. Two policies: **task-scoped** one-shots (`/clear` transcript summarization) follow the **task's own agent**, so a Codex task's handoff note is written by Codex and counted against the Codex login; **project-scoped** one-shots (recap, context draft) aren't tied to any one task, so they run on the configured **utility agent** (the `utility_agent` app setting, default `claude` — Settings). Either way, if the chosen driver doesn't implement a given helper, the utility agent backstops it — so a new driver can ship `runTurn()` alone and still get working summaries/recaps/drafts. AI conflict-resolution turns need no special routing: `buildConflictPrompt()` (`lib/agents/shared.ts`) produces the prompt and the client sends it as an ordinary message, so it flows through `startTurn()` → the task's driver like any turn.
- **Adding a third agent** (e.g. Gemini, Cursor): implement the `AgentDriver` interface in `lib/agents/<id>/driver.ts` (`runTurn()` is the only required method — the one-shot helpers are optional and fall back to the utility agent), register it in `lib/agents/registry.ts`, and ship its CLI in the `Dockerfile` (installed on `PATH` next to `claude` / `codex`). No edits to the runner, routes, recap/refresh jobs, or UI data flow — the capability descriptor drives the pickers, the `/api/agents/[id]/*` routes are generic, and `getDriver(task.agent)` resolves it everywhere. The driver contract test (`tests/agentDriver.test.ts`) and the event-mapping test (`tests/codexEvents.test.ts`) are the templates for pinning a new driver to the same `StreamEvent` contract.
- **The agent-tool bridge (`scripts/orch-mcp.mjs` + `lib/agentTools.ts`)** — `suggest_task` / `expose_service` are the same two tools every driver exposes. The Claude driver mounts them as an in-process SDK MCP server (`createSdkMcpServer`), a construct that only exists inside the Claude Agent SDK; the portable equivalent is **`scripts/orch-mcp.mjs`**, a plain-Node stdio MCP server (`@modelcontextprotocol/sdk`) the non-Claude drivers spawn per turn. It's a thin proxy: it reads `ORCH_TASK_ID` / `ORCH_PROJECT_ID` / `ORCH_BASE_URL` / `SERVICE_TOKEN` from env (injected by the driver) and POSTs each tool call to the app's internal endpoints (`app/api/internal/agent-tools/{suggest-task,expose-service}`, gated by the strict per-instance `SERVICE_TOKEN` in `middleware.ts`). Both the in-process server and the endpoints call the SAME shared logic in **`lib/agentTools.ts`**, and both build their tool defs from the SAME constants in **`lib/agentToolDefs.mjs`**, so the two paths can't drift.
- **`lib/services.ts`** — the managed-services supervisor: starts/stops/restarts a project's configured `dev`/`setup`/`test` commands as detached process-group children **owned by the server** (not a turn or a tab), captures their stdout/stderr into a per-service ring buffer, and publishes status/log events to the `services/stream` SSE route. State lives on `globalThis` (survives HMR), like `lib/events.ts`. `exposeService()` backs the `expose_service` MCP tool — an informational entry for a server Claude started itself. Each project gets a stable `PORT` (`projects.port`, deterministic from `ORCH_SERVICE_PORT_BASE`) injected into every service's env and the PTY shell. Behind `ORCH_FEATURE_SERVICES`, the registry is **persisted** (`services` table) and every service gets a stable **public hostname** `<slug>--<appHost>` with per-service visibility (private / shared-link / public): `server.js` restores + auto-restarts managed services on boot (loopback ping to `/api/instance/services-restore`) and dispatches service hostnames through the reverse-proxy router in **`lib/service-router.mjs`** (WebSocket/HMR passthrough included), with the pure hostname/token helpers in **`lib/service-host.mjs`**.
- **`lib/contextRefresh.ts`** — "Refresh with AI" orchestration as a **detached background job** (so a multi-minute draft never holds an HTTP request open across the tunnel and can't be slept under): `startRefreshJob()` seeds the utility agent with recent git activity, runs `draftProjectContext()` in the repo (read-only), and persists the result (`refresh_status`/`refresh_draft` on the project) for the client to poll via `GET /api/projects/[id]/refresh-context`. The draft is for the user to review — never auto-saved into `context`. In-flight work marks the instance busy (`workStarted/workEnded` in `lib/idle.ts`) so the idle daemon won't `docker stop` mid-refresh.
- **`lib/git.ts`** — per-task worktrees/branches, diffs, and merging (`mergeTask()`, plus `prepareWorktreeMerge()` / `completeWorktreeMerge()` / `abortWorktreeMerge()` for AI/manual conflict resolution; `worktreeSyncStatus()` / `fastForwardWorktree()` to catch a stale branch up to base).
- **`lib/recap.ts`** — "where you left off" staleness/activity logic + background sweep.
- **`lib/runner.ts`** — the detached turn runner: a turn runs server-side, owned by the process (not by any HTTP request), persisting every event to SQLite and publishing it on **`lib/events.ts`** (in-process pub/sub keyed by task id, plus a wildcard channel that sees every task's events). Stopping is only ever explicit, via `lib/abort.ts`.
- **`app/api/...`** — REST; `tasks/[id]/messages` `POST` launches a turn in the runner and returns immediately — or, if a turn is already running, parks the message in the `pending_messages` queue to run next (`GET` snapshots the parked queue alongside the transcript; `DELETE tasks/[id]/pending` cancels a queued message); `GET` on `messages` is the SSE watch stream (a `snapshot` of the persisted transcript, then a live tail — reconnect-safe, any number of viewers); merge routes under `tasks/[id]/merge/*`; the divergence/sync route at `tasks/[id]/sync`. `GET /api/events` is the global lifecycle stream: one always-open SSE connection per client tab broadcasting coarse turn boundaries (turn started / awaiting input / answered / suggestion created / turn ended) for every task across every project, each event a fresh snapshot of the task row plus its project's awaiting count — how spinners, project badges, and the "N need you" pill update instantly for tasks whose transcript stream isn't open (no polling).
- **`app/Orchestrator.tsx`** — the dark mission-control client UI (projects rail · task list · live session, the session split into transcript + `SessionRail` DIFF/PREVIEW/CONTEXT tabs); one `EventSource` per selected task renders from server events, so a reload, sleep, or task switch mid-turn just catches up.
- **`server.js`** — custom Next.js server (Turbopack in dev); proxies `/pty` WebSocket upgrades to the sidecar so the app + terminal share one origin, and forwards HMR upgrades to Next.
- **`app/Terminal.tsx`** + **`pty-server.js`** — xterm.js ↔ same-origin `/pty` WebSocket (proxied by `server.js`) ↔ `node-pty` sidecar bound to `127.0.0.1`.

</details>

## Notes & caveats

- **Permissions:** sessions run with `permissionMode: "bypassPermissions"` (`lib/agents/claude/driver.ts`) so they don't block on prompts. Switch to `"acceptEdits"` for a safety gate.
- **Parallel quota:** every concurrent task spends your rate limit — N tasks ≈ N× the token rate against one subscription.
- **Terminal:** the `node-pty` sidecar stays bound to `127.0.0.1` only — it's never exposed directly. The browser reaches it through the app origin at `/pty` (proxied by `server.js`), so remote access goes through your one tunneled hostname. `postinstall` (`scripts/fix-pty.js`) restores the `+x` bit npm can strip off node-pty's prebuilt helper.
- **Delete is hard delete:** a removed project's chat history is gone (your code on disk is untouched).
