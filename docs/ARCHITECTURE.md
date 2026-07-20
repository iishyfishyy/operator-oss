# Architecture

How Operator is put together. This is the public companion to [`CLAUDE.md`](../CLAUDE.md)
(the in-repo codebase map agents read); if the two ever disagree, trust the code.

## Three processes, one origin

- **`server.js`** — custom Next.js server (plain Node, Turbopack in dev). Fronts Next on one
  port, proxies `/pty` WebSocket upgrades to the sidecar, and forwards dev HMR upgrades to
  Next. Because everything rides one origin, a Cloudflare Tunnel (or any reverse proxy)
  exposing a single https hostname carries both the app and the terminal — no second port,
  and `wss://` is used automatically over https.
- **`pty-server.js`** — the node-pty terminal sidecar, bound to `127.0.0.1` only; never
  exposed directly. The browser reaches it through the app origin at `/pty`.
- **The Next app** — UI in `app/`, REST under `app/api/`, server logic in `lib/`.

## The turn lifecycle

**`lib/runner.ts`** is the detached turn runner: `POST /api/tasks/[id]/messages` launches a
turn and returns immediately — the turn runs server-side, owned by the process (not by any
HTTP request), persisting every event to SQLite and publishing it on **`lib/events.ts`**
(in-process pub/sub keyed by task id, plus a wildcard channel that sees every task's
events). Stopping is only ever explicit, via `lib/abort.ts`. If a turn is already running,
the message parks in the `pending_messages` queue to run next.

`GET` on the same route is the SSE watch stream: a `snapshot` of the persisted transcript,
then a live tail — reconnect-safe, any number of viewers, zero viewers fine.

`GET /api/events` is the global lifecycle stream: one always-open SSE connection per client
tab broadcasting coarse turn boundaries (turn started / awaiting input / answered /
suggestion created / turn ended) for every task across every project. Each event carries a
fresh snapshot of the task row plus its project's awaiting count — that's how spinners,
project badges, and the "N need you" pill update instantly for tasks whose transcript
stream isn't open. There is no task-list polling.

**A task is a lineage of sessions.** Generation N ends at `/clear`; its transcript is
condensed to a summary, and generation N+1 starts with a clean context window seeded by all
prior summaries. The task persists — only the context window resets.

## The agent-driver seam (`lib/agents/`)

The app talks to coding agents only through the `AgentDriver` interface.

- **`types.ts`** defines the interface: a normalized `StreamEvent` turn contract, one-shot
  summarize/draft/recap helpers, a capability descriptor, and the login/verify auth surface.
- **`registry.ts`** resolves a driver by id — `getDriver(task.agent)`, persisted per task,
  defaulted per project via `projects.default_agent`.
- **`shared.ts`** holds the agent-agnostic pieces every driver reuses: project-context and
  conflict prompts, tool-call → title/peek/diff normalizers, the event queue.
- **`GET /api/agents`** serves each driver's capability descriptor **plus its persisted
  connection state** to the client, which renders every run-control picker (model /
  reasoning / permission), the per-task agent picker, agent badges, and the cost/ask
  feature gates from that data — no hardcoded per-agent lists in the UI.
- Connecting an agent is driver-driven and route-generic:
  **`/api/agents/[id]/{login,login/code,verify,api-key,status}`** resolve
  `getDriverStrict(id)` and call its auth surface, so a new agent costs zero new routes;
  `connections.ts` records which agents are connected. Each agent's credentials live under
  `$HOME` (Claude `~/.claude`, Codex `~/.codex`); the optional per-token API-key paths
  persist to a 0600 file (`lib/anthropic-key.ts` / `lib/openai-key.ts`).

### The Claude driver (`lib/agents/claude/driver.ts`)

`runTurn()` via the Claude Agent SDK (resume or fresh session, project context appended to
the Claude Code system prompt), the `suggest_task` + `expose_service` MCP tools,
`summarizeTranscript()` for `/clear`, and `draftProjectContext()` (a read-only agent loop
that explores the repo to refresh a project's saved context). Auth delegates to
`lib/claude-auth.ts`. Sessions run `permissionMode: "bypassPermissions"`.

### The Codex driver (`lib/agents/codex/driver.ts`)

Driven by the user's ChatGPT-plan `codex` login (no API key). Built on `@openai/codex-sdk`
(it spawns the `codex` CLI and speaks JSONL over stdio, same architecture as the Claude
driver): `startThread()` / `resumeThread(session_id)`, with the codex thread id emitted as
the `session` event so lineage/resume works unchanged. `events.ts` normalizes codex's
`ThreadItem` stream (agent_message → assistant; command_execution / file_change /
mcp_tool_call / web_search / todo_list / reasoning → tool + tool_result; `turn.completed`
usage → tokens plus an **estimated** `cost_usd`) into the `StreamEvent` contract.

Run controls map our permission modes to codex's sandbox/approval policy
(bypassPermissions → workspace-write + approvals-never; plan → read-only); reasoning
presets map to `model_reasoning_effort`. Capabilities declare `supportsMcpTools: true` (the
orchestrator's tools reach codex through the portable stdio MCP bridge below, registered
per turn with a ~1-day `tool_timeout_sec` so a parked ask survives),
`supportsAsks: true` (codex has no native interactive-ask hook, but the bridge's
`ask_user` tool surfaces the same question card and blocks until the user answers) and
`reportsCostUsd: false` + `costIsEstimated: true` — ChatGPT-plan auth reports token counts
only, so `pricing.ts` estimates the dollar cost per turn (tokens × published API prices
for the resolved model) and the UI renders those figures with a `~`. The one upstream
limitation not papered over: the non-interactive CLI cannot pause a turn for **command
approval**, so on-request approval modes aren't offered — permission modes are Auto-run
(workspace-write, approvals never) and Plan (read-only). Auth (`auth.ts`) drives
`codex login --device-auth` + `codex login status`. The one-shot helpers run as
`codex exec` one-shots in a **read-only sandbox** (no writes, no approvals, no network),
bounded by an item cap — the codex analog of the Claude helpers' `maxTurns` — so a
runaway helper turn is cut off rather than looping unbounded.
Binary via `CODEX_CLI_PATH` (else the SDK auto-resolves its bundled binary / PATH).

### Internal one-shots (`lib/agents/oneshots.ts`)

Routing for the internal jobs that run a turn **outside the main chat**: `/clear` handoff
summaries, project recaps, and "Refresh with AI" context drafts. Two policies:
**task-scoped** one-shots (`/clear` transcript summarization) follow the **task's own
agent**, so a Codex task's handoff note is written by Codex and counted against the Codex
login; **project-scoped** one-shots (recap, context draft) aren't tied to any one task, so
they run on the **utility agent**, resolved **connected-first**: the `utility_agent` app
setting when that agent is actually connected → the app default agent → the built-in
default → any connected agent at all — so a Codex-only instance gets working recaps and
context drafts with zero configuration, and when NO agent is connected the job fails fast
with an actionable "connect an agent in Settings → Agents" error instead of driving a dead
CLI. Either way, if the chosen driver doesn't implement a given helper, the utility
agent backstops it — so a new driver can ship `runTurn()` alone and still get working
summaries/recaps/drafts. AI conflict-resolution turns need no special routing:
`buildConflictPrompt()` (`lib/agents/shared.ts`) produces the prompt and the client sends
it as an ordinary message, so it flows through `startTurn()` → the task's driver like any
turn.

### The agent-tool bridge (`scripts/orch-mcp.mjs` + `lib/agentTools.ts`)

`suggest_task` / `expose_service` / `ask_user` are the same orchestrator tools every driver
exposes. The Claude driver mounts the first two as an in-process SDK MCP server
(`createSdkMcpServer`) and gets asks natively via its AskUserQuestion hook; the portable
equivalent is **`scripts/orch-mcp.mjs`**, a plain-Node stdio MCP server
(`@modelcontextprotocol/sdk`) the non-Claude drivers spawn per turn. It's a thin proxy: it
reads `ORCH_TASK_ID` / `ORCH_PROJECT_ID` / `ORCH_BASE_URL` / `SERVICE_TOKEN` from env
(injected by the driver) and POSTs each tool call to the app's internal endpoints
(`app/api/internal/agent-tools/{suggest-task,expose-service,ask-user}`, gated by the strict
per-instance `SERVICE_TOKEN` in `middleware.ts`). `ask_user` is the asynchronous one: the
endpoint persists + publishes the same interactive question card the Claude hook produces,
parks a **detached** waiter on the user's answer (`lib/asks.ts`, tied to the turn's abort
signal), and the bridge **polls** the sibling `ask-user/wait` endpoint for the settled
outcome — no long-held HTTP request, and the ask survives page reloads because the card
lives in the transcript. Both the in-process server and the endpoints call the SAME shared
logic in **`lib/agentTools.ts`**, and both build their tool defs from the SAME constants in
**`lib/agentToolDefs.mjs`**, so the two paths can't drift.

### Adding a third agent (e.g. Gemini, Cursor)

Implement the `AgentDriver` interface in `lib/agents/<id>/driver.ts` (`runTurn()` is the
only required method — the one-shot helpers are optional and fall back to the utility
agent), register it in `lib/agents/registry.ts`, and ship its CLI in the `Dockerfile`
(installed on `PATH` next to `claude` / `codex`). No edits to the runner, routes,
recap/refresh jobs, or UI data flow — the capability descriptor drives the pickers, the
`/api/agents/[id]/*` routes are generic, and `getDriver(task.agent)` resolves it
everywhere. The driver contract test (`tests/agentDriver.test.ts`) and the event-mapping
test (`tests/codexEvents.test.ts`) are the templates for pinning a new driver to the same
`StreamEvent` contract.

## Everything else, by module

- **`lib/db.ts`** — SQLite schema, migrations, seed. **`lib/store.ts`** — typed queries for
  projects / tasks / messages / summaries / sessions.
- **`lib/git.ts`** — per-task worktrees/branches, diffs, and merging (`mergeTask()`, plus
  `prepareWorktreeMerge()` / `completeWorktreeMerge()` / `abortWorktreeMerge()` for
  AI/manual conflict resolution; `worktreeSyncStatus()` / `fastForwardWorktree()` to catch
  a stale branch up to base).
- **`lib/services.ts`** — the managed-services supervisor: starts/stops/restarts a
  project's configured `dev`/`setup`/`test` commands as detached process-group children
  **owned by the server** (not a turn or a tab), captures their stdout/stderr into a
  per-service ring buffer, and publishes status/log events over SSE. State lives on
  `globalThis` (survives HMR), like `lib/events.ts`. Each project gets a stable `PORT`
  (`projects.port`, deterministic from `ORCH_SERVICE_PORT_BASE`) injected into every
  service's env and the PTY shell. On by default (`ORCH_FEATURE_SERVICES=0` disables):
  the registry is **persisted** (`services` table) and `server.js` restores +
  auto-restarts managed services on boot — first **reaping any process group a crashed
  server left orphaned** (the spawn pid is persisted per row; the reaper verifies the
  group still runs the service's command before `SIGKILL`ing it, so a recycled pid is
  never killed by mistake), and probing the port first so a conflict with an unmanaged
  process surfaces as a readable `error` on the service instead of an EADDRINUSE crash
  loop. A clean process exit SIGKILLs every managed group on the way out. Running
  services don't block idle-stop (`/api/instance/idle` reports `runningServices`
  informationally — sleeping is safe because boot restore relaunches them). **Public
  hostnames are a separate opt-in** (`ORCH_SERVICE_HOSTS`): each service then gets a
  stable `<slug>--<appHost>` hostname with per-service visibility (private /
  shared-link / public), dispatched through the reverse-proxy router in
  **`lib/service-router.mjs`** (WebSocket/HMR passthrough included), with the pure
  hostname/token helpers in **`lib/service-host.mjs`**.
- **`lib/contextRefresh.ts`** — "Refresh with AI" as a **detached background job** (a
  multi-minute draft never holds an HTTP request open across a tunnel): `startRefreshJob()`
  seeds the utility agent with recent git activity, runs `draftProjectContext()` in the
  repo (read-only), and persists the result for the client to poll via
  `GET /api/projects/[id]/refresh-context`. The draft is for the user to review — never
  auto-saved. In-flight work marks the instance busy (`lib/idle.ts`) so an idle daemon
  won't stop the container mid-refresh.
- **`lib/recap.ts`** — "where you left off" staleness/activity logic + background sweep.
- **`app/Orchestrator.tsx`** — the dark mission-control client UI (projects rail · task
  list · live session, the session split into transcript + `SessionRail`
  DIFF/PREVIEW/CONTEXT tabs); one `EventSource` per selected task renders from server
  events, so a reload, sleep, or task switch mid-turn just catches up.
- **`app/Terminal.tsx`** + **`pty-server.js`** — xterm.js ↔ same-origin `/pty` WebSocket
  (proxied by `server.js`) ↔ `node-pty` sidecar bound to `127.0.0.1`.

## Where data lives

| What | Where |
|-|-|
| Projects, tasks, transcripts, summaries, session index | `orchestrator.db` (SQLite) in `ORCH_DB_DIR`, default `~/.zen-orchestrator` |
| Per-task git worktrees | `ORCH_WORKTREES_DIR`, default `~/.agent-orchestrator/worktrees` — deliberately outside every repo |
| Cloned project repos | `ORCH_PROJECTS_DIR`, default `~/projects` |
| Your apps' actual code | each project's working directory — never inside Operator's own tree |
| Claude Code's raw session logs | `~/.claude/projects/...` (managed by Claude Code) |

**Stack:** Next.js (App Router) + TypeScript · React 19 · better-sqlite3 ·
`@anthropic-ai/claude-agent-sdk` · xterm.js + node-pty sidecar · streaming over SSE.
