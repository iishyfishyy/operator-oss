# CLAUDE.md

Orchestrator — a local-first web app that runs many Claude Code sessions in parallel across multiple projects from one screen. Each **project** carries reusable context + a working directory; each **task** is its own Claude Code session in its own git worktree, driven by `@anthropic-ai/claude-agent-sdk` against the user's local Claude login (no API key). (A hosted version, getoperator.dev, lives in a separate private repo that overlays this one — see "Repo split" below.)

## Commands

- `npm run dev` — app (:3000, `server.js`) + pty sidecar (:3001, `pty-server.js`) via concurrently. `npm run dev:next` / `npm run pty` run them separately.
- `npm run build` (turbopack) then `npm start` for production.
- `npm test` — vitest, serial on purpose (tests spawn many real git subprocesses). Single file: `npx vitest run tests/merge.test.ts`.
- No lint script; TypeScript is strict, path alias `@/*` → repo root (mirrored in `vitest.config.ts`).

## Architecture

Three processes/entrypoints, one origin:

- **`server.js`** — custom Next.js server (plain Node, CommonJS). Fronts Next on one port, proxies `/pty` WebSocket upgrades to the sidecar, forwards dev HMR upgrades to Next, enforces origin auth on WebSocket upgrades (middleware never sees upgrades — this file is the auth boundary for the terminal), and dispatches public service hostnames (`<slug>--<appHost>`) through `lib/service-router.mjs`.
- **`pty-server.js`** — node-pty sidecar, bound to `127.0.0.1` only; never exposed directly.
- **Next app** — UI in `app/`, REST under `app/api/`, server logic in `lib/`.

### The turn lifecycle (core flow)

`POST /api/tasks/[id]/messages` doesn't run the turn — it calls `startTurn()` in **`lib/runner.ts`** and returns. The turn runs detached, owned by the server process: every event is persisted to SQLite and fanned out via **`lib/events.ts`** (in-process pub/sub keyed by task id, plus a wildcard channel — `subscribeGlobal()` — that sees every task's events). `GET` on the same route is the SSE watch stream: a `snapshot` of the persisted transcript, then a live tail — reconnect-safe, any number of viewers, zero viewers fine. Stopping is only explicit (`lib/abort.ts`). If a turn is already running, POST parks the message in `pending_messages` to run next.

Only the SELECTED task has a transcript stream open. Everything else stays live through `GET /api/events` — one always-open EventSource per tab (`app/orchestrator/useGlobalEvents.ts`) broadcasting coarse lifecycle events for every task across every project (turn started / awaiting input / answered / suggestion created / turn ended). Each payload re-reads the task row at publish time — the runner persists BEFORE it publishes, so the snapshot is authoritative (pinned by `tests/agentDriver.test.ts`); it also carries the project's fresh awaiting count. That's what updates spinners, project badges, and the "N need you" pill for unselected tasks — there is no task-list polling.

**`lib/agents/`** is the agent-driver seam: the app talks to coding agents only through the `AgentDriver` interface (`types.ts` — normalized `StreamEvent` turn contract, one-shot summarize/draft/recap helpers, capability descriptor, login/verify auth surface), resolved via `getDriver(task.agent)` in `registry.ts` (`tasks.agent`, defaulted from `projects.default_agent`; unknown ids fall back to Claude). `shared.ts` holds the agent-agnostic normalizers (project-context/conflict prompts, tool-call → title/peek/diff, the event queue). `GET /api/agents` exposes each driver's capabilities to the client. Session/thread ids are opaque per driver (`sessions.claude_session_id` stores any driver's id).

**`lib/agents/claude/driver.ts`** is the Claude Code driver: `runTurn()` via the Agent SDK (resume or fresh session; project context is appended to the Claude Code system prompt via `buildProjectContext()`), the `suggest_task`/`expose_service` MCP tools, `summarizeTranscript()` for `/clear`, `draftProjectContext()` (read-only repo-exploring agent); auth delegates to `lib/claude-auth.ts`. Sessions run `permissionMode: "bypassPermissions"`. **`lib/agents/codex/driver.ts`** is the OpenAI Codex driver (`@openai/codex-sdk` spawns the `codex` CLI, JSONL over stdio; `codex/events.ts` normalizes its `ThreadEvent` stream); its one-shot helpers are `codex exec` runs in a read-only sandbox. Non-Claude drivers get the orchestrator tools (`suggest_task`/`expose_service`/`ask_user`) via the stdio MCP bridge `scripts/orch-mcp.mjs` → `/api/internal/agent-tools/*`; `ask_user` restores interactive asks (card persisted + published by `lib/agentTools.startAskUser`, bridge polls the `wait` endpoint for the answer).

**Internal jobs run through `lib/agents/oneshots.ts`** — the turns that run *outside* the main chat. Two policies: **task-scoped** (`/clear` transcript summarization) follows the **task's own agent** (so a Codex task's handoff note bills the Codex login); **project-scoped** (recap, "Refresh with AI" context draft) runs the **utility agent**, resolved **connected-first** (`utility_agent` setting if connected → app default → built-in default → any connected agent; nothing connected → actionable error, never a dead CLI). A driver that doesn't implement a helper is backstopped by the utility agent, so the one-shot helpers on `AgentDriver` are optional — only `runTurn()` is required. The first-run wizard requires **an** agent, not Claude: finishing with only Codex connected adopts it as the app default and retargets the seeded tutorial (`completeOnboarding` in `lib/onboarding.ts`). AI conflict-resolution turns need no special routing: the client sends `buildConflictPrompt()` output as an ordinary message through `startTurn()` → the task's driver.

**Adding a third agent**: implement `AgentDriver` in `lib/agents/<id>/driver.ts` (only `runTurn()` is required), register it in `registry.ts`, ship its CLI in the `Dockerfile`. Nothing else changes — the runner, routes, recap/refresh jobs, and UI data flow are all seam-generic. Pin it with the driver-contract test (`tests/agentDriver.test.ts`, which mocks a driver's CLI at the SDK boundary and runs it through the real runner).

**A task is a lineage of sessions**: `/clear` ends generation N, condenses its transcript to a summary, and generation N+1 starts fresh seeded with all prior summaries.

### Key modules (by responsibility)

- `lib/db.ts` — SQLite schema + migrations (single shared connection, WAL); `lib/store.ts` — typed queries; `lib/types.ts` — shared types.
- `lib/git.ts` — per-task worktrees/branches, diffs, merge (`mergeTask`, `prepareWorktreeMerge`/`completeWorktreeMerge`/`abortWorktreeMerge`), base-branch sync (`worktreeSyncStatus`/`fastForwardWorktree`).
- `lib/services.ts` — managed-services supervisor (detached process-group children owned by the server, log ring buffers, SSE status); `lib/service-router.mjs` + `lib/service-host.mjs` — public service-hostname reverse proxy + pure host/token helpers.
- `lib/contextRefresh.ts` — "Refresh with AI" as a detached background job (poll via GET, never a long-held request); `lib/recap.ts` — staleness/activity sweep. Both are project-scoped one-shots that run on the utility agent via `lib/agents/oneshots.ts`. `lib/idle.ts` — busy-tracking so the idle daemon won't stop the container mid-work.
- `lib/config.ts` — all per-instance config, env-driven with documented defaults; `lib/features.ts` — feature flags (env → `resolveFeatures()` server-side, `window.__FEATURES` client-side).
- Auth: `middleware.ts` gates every HTTP route (no matcher on purpose); provider selected by `lib/auth/origin.mjs` (open local mode by default, Cloudflare Access when `CF_ACCESS_*` is set); threat model in `lib/cf-access.mjs`. Health/version routes accept the shared `SERVICE_TOKEN` instead.
- UI: `app/Orchestrator.tsx` is the three-column shell (projects · tasks · live session); the pieces live in `app/orchestrator/` (`useTaskStream.ts` owns the one-EventSource-per-task logic, `SessionRail.tsx` the DIFF/PREVIEW/CONTEXT tabs). `app/Terminal.tsx` is xterm.js over the `/pty` proxy.

### Repo split (OSS ↔ hosted)

This is the **open-source repo** — the whole local app lives here and all core development happens here. The hosted product (control plane, billing, fleet provisioning, first-party auth, deploy scripts) lives in a **private overlay repo** that tracks this one as upstream: it re-adds the private files and carries hosted variants of a few fork-point files (`middleware.ts`, `lib/auth/origin.mjs`, `server.js`, `app/api/auth/logout/route.ts`, `Dockerfile`, `docker-compose.yml`, `.env.example`, `README.md`, this file). Don't add hosted/control-plane features here; don't reference private scripts or docs from public files.

### Where data lives

| What | Where |
|-|-|
| DB (projects, tasks, transcripts, summaries) | `orchestrator.db` in `ORCH_DB_DIR` (default `~/.zen-orchestrator`) |
| Per-task git worktrees | `ORCH_WORKTREES_DIR` (default `~/.agent-orchestrator/worktrees`) — deliberately **outside** every repo |
| Cloned project repos | `ORCH_PROJECTS_DIR` (default `~/projects`) |

## Conventions & gotchas

- **Env-driven, zero code edits per instance.** Every per-instance knob is an env var with a documented default — add new ones to `lib/config.ts` (or `lib/features.ts` for flags) **and** `.env.example`. `server.js`/`pty-server.js` can't import TS, so they read the same env names directly; keep names in sync.
- **Plain-Node entrypoints stay plain.** `server.js` is CommonJS; anything it needs from `lib/` must be `.mjs` (dynamic-imported) — and every such `.mjs` file must be COPY'd into the runtime image in the `Dockerfile` (Next's build output doesn't include them; this has bitten before).
- **`next.config.mjs` stays JS**, not TS — prod containers prune dev deps and a `.ts` config needs the `typescript` package at runtime.
- **HMR-surviving server state lives on `globalThis`** (`lib/events.ts`, `lib/abort.ts`, `lib/asks.ts`, `lib/services.ts` all follow this pattern). Single Node process; no external queue/broker.
- **Long work is a detached background job, never a held HTTP request** (turns, context refresh, services). Anything multi-minute must survive page reloads and tunnel drops, and should mark the instance busy via `lib/idle.ts` so the sleep daemon doesn't stop the container mid-work.
- **Native modules** (`better-sqlite3`, `node-pty`) and the Agent SDK are in `serverExternalPackages` — don't let Next bundle them. `postinstall` fixes node-pty's exec bit.
- **Tests are hermetic**: `tests/setup.ts` points `ORCH_DB_DIR`/`ORCH_WORKTREES_DIR` at tmp dirs and pins git config *before the module graph loads* (config is read at import time). Use `tests/helpers.ts` for git fixtures. New env-read-at-import config must be set there too.
- **Delete is hard delete** throughout — no soft-delete/undo.
- **Auth is layered on purpose**: Next middleware for HTTP, `server.js` for WebSocket upgrades, per-service visibility for public service hostnames. When adding a route or upgrade path, decide which gate covers it.
- **Commits are detailed** (explain the why); **keep README.md current** with app state when behavior changes. Markdown tables use minimal separators (`|-|-|`).

## More detail

`README.md` (features, configuration, self-hosting, architecture map) · `.env.example` (every env var, documented).
