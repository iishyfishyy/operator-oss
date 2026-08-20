# Self-hosting

Everything about running your own instance: Docker, tunnels, auth, configuration, and
the idle signal. The [README](../README.md) has the two-command version; this is the rest.

## Docker

The [`Dockerfile`](../Dockerfile) builds a single-user image: a **production** Next.js
build (a stopped container starts in seconds) bundling Node 22, git, and the `claude`
CLI, with [`docker/entrypoint.sh`](../docker/entrypoint.sh) running both processes (app
server + pty sidecar) under tini. All state lives under `/home/orch` — one named volume
captures the SQLite db, worktrees, project repos, and claude login.
[`docker-compose.yml`](../docker-compose.yml) is the parameterized runner:

```bash
docker build -t agent-orchestrator .
ORCH_USER=alice ORCH_PORT=10001 ORCH_RUNTIME=runc \
  docker compose -p orch-alice up -d
# open http://127.0.0.1:10001
```

The container publishes its port on the **host's loopback only**. To reach it from
elsewhere, put an authenticated tunnel or reverse proxy in front — this app hands out a
full shell and a `bypassPermissions` agent, so **never expose the port raw**.

The `claude` CLI works headless: it prints the OAuth URL and accepts a pasted code, and
the setup wizard drives that flow from the browser.

### Amazon Bedrock

The image also includes the AWS CLI and persists `~/.aws` on the home volume. To use
Bedrock instead of a Claude subscription, set `CLAUDE_CODE_USE_BEDROCK=1`, configure a
region, and provide credentials through the AWS default credential chain. A Bedrock API
key via `AWS_BEARER_TOKEN_BEDROCK` is the simplest headless option; profiles, SSO, and
temporary access-key credentials are also supported. Restart the container, then open
Settings → Agents → Amazon Bedrock and run Verify.

Claude provider selection is instance-wide: do not configure Anthropic subscription/API
credentials and Bedrock credentials in the same Operator instance. Model IDs, cross-region
inference profile IDs, and application inference-profile ARNs can be entered with
**Custom model** in a task's model picker.

## Origin-side auth (Cloudflare Access)

If you front an instance with Cloudflare Access, set `CF_ACCESS_TEAM_DOMAIN` +
`CF_ACCESS_AUD` and the origin re-verifies the Access JWT (`Cf-Access-Jwt-Assertion`
header / `CF_Authorization` cookie, checked against the team's public signing keys and
the app's `aud` tag) on **every HTTP route** (Next.js middleware) **and on every
WebSocket upgrade** (`server.js`, in front of the `/pty` terminal proxy). No valid
assertion → 403. [`lib/cf-access.mjs`](../lib/cf-access.mjs) is the single shared
verifier; the titlebar shows the authenticated email.

Unset (the local default), the app has no login, but it still enforces a browser-origin
boundary: loopback hosts are accepted, cross-site requests are rejected, and `/pty`
WebSocket upgrades require a matching browser `Origin`. This prevents an unrelated
website from driving the local shell and blocks DNS-rebinding hostnames. `PUBLIC_BASE_URL`
is accepted automatically; intentional LAN access must list its exact origin in
`ORCH_ALLOWED_ORIGINS`. This remains a single-user mode, not authentication — never expose
it raw to the internet.

The one Access-mode exception is `SERVICE_TOKEN`: a shared secret letting health probes
read the documented service-token routes without an Access JWT
(`x-service-token` header).

## Idle signal

`GET /api/instance/idle` reports whether the instance can be safely stopped: live turn
count, open transcript SSE streams, open terminal WebSockets, awaiting-input tasks, and
the last-request timestamp. Polling it does not itself count as activity, and the image
uses it as its `HEALTHCHECK`. An external supervisor can consume it to stop/start idle
containers.

Running managed services are reported as `runningServices` but deliberately do **not**
make the instance busy: each service's desired state is persisted, and boot restore
relaunches it at the same URL when the container comes back, so stopping loses nothing.
A supervisor that prefers to keep an instance warm while a user-visible service runs can
apply its own policy on that count.

## Configuration

Every per-instance value is an env var with a documented default — one env set fully
relocates an instance (fresh container, different user, different ports) with **zero
code edits**. [`.env.example`](../.env.example) is the same list in copyable form.
Export the variables in the environment that launches `npm run dev` / `npm start` —
`server.js` and `pty-server.js` are plain Node and read them before Next boots, so a
`.env` file alone doesn't cover `PORT`/`ORCH_HOSTNAME`/`PTY_*`.

| Variable | Default | What it does |
|-|-|-|
| `PORT` | `3000` | Port of the single public origin (Next.js + `/pty` proxy) |
| `ORCH_HOSTNAME` | `127.0.0.1` | Bind address of the app server. Loopback by default: a local instance is unauthenticated and hands out a shell, and the origin gate is a header check that a LAN client can forge past, so only the bind closes that. Widen it only behind `CF_ACCESS_*`. Bare `HOSTNAME` is deliberately **not** read — shells and container runtimes inject it. The image sets `ORCH_HOSTNAME=0.0.0.0`, correct inside a container whose port is published on the host's loopback |
| `PTY_PORT` | `3001` | Port of the node-pty terminal sidecar |
| `PTY_HOST` | `127.0.0.1` | Bind address of the sidecar **and** the proxy's upstream. Keep it on loopback — the browser never connects directly; `server.js` proxies `/pty` to it |
| `PUBLIC_BASE_URL` | *(empty)* | The origin users reach the app on (e.g. `https://orch.example.com` behind a tunnel). The client builds its `ws(s)://` terminal URL from it; empty = the browser's own origin, correct for any single-hostname deployment |
| `ORCH_ALLOWED_ORIGINS` | *(empty)* | Exact comma-separated `http(s)` origins additionally allowed in no-login local mode, for intentional LAN/reverse-proxy access. Loopback origins and `PUBLIC_BASE_URL` are already accepted. This is not a substitute for authentication |
| `ORCH_PTY_ALLOW_REMOTE` | *(off)* | Set `1` to let the pty sidecar accept off-machine peers. It otherwise requires a loopback peer, since `server.js` proxies to it from the same host — an address check the caller cannot forge, unlike a header. Only for a deliberately split deployment; anything reaching the sidecar gets a shell |
| `CF_ACCESS_TEAM_DOMAIN` | *(empty)* | Cloudflare Zero Trust team domain (e.g. `your-team.cloudflareaccess.com`); see above |
| `CF_ACCESS_AUD` | *(empty)* | The Access application's `aud` tag the JWT must carry (comma-separable) |
| `SERVICE_TOKEN` | *(empty)* | Shared secret for the idle/health route; see above |
| `ORCH_DB_DIR` | `~/.zen-orchestrator` | Directory holding `orchestrator.db` (SQLite app data). Absolute path; created on first run |
| `ORCH_WORKTREES_DIR` | `~/.agent-orchestrator/worktrees` | Where per-task git worktrees are created. Must live outside any project repo |
| `ORCH_PROJECTS_DIR` | `~/projects` | Where **Clone from GitHub** puts cloned repos |
| `ORCH_SERVICE_PORT_BASE` | `4300` | Base of the deterministic per-project port block. Each project is assigned `base + slot` at creation, injected as `PORT` into its supervised services and PTY |
| `ORCH_SERVICE_LOG_LINES` | `1500` | Per-service in-memory log ring buffer (lines) kept for the Services drawer |
| `ORCH_SERVICE_HOSTS` | *(off)* | Set `1` to serve each service on a public hostname `<slug>--<appHost>` with per-service visibility (private / shared link / public). Separate opt-in from the services feature itself; also needs `PUBLIC_BASE_URL` + wildcard DNS/TLS |
| `ORCH_FEATURE_SERVICES` | `1` (on) | The managed-services feature (Services drawer, supervisor, persisted registry with boot auto-restart + orphan reaping). Set `0` to disable |
| `CLAUDE_CLI_PATH` | `~/.local/bin/claude` | Path to the logged-in `claude` CLI (pinned because Next's server may run with a trimmed `PATH`) |
| `CLAUDE_CODE_USE_BEDROCK` | *(off)* | Set `1` to route every Claude turn and utility job through Amazon Bedrock instead of Anthropic |
| `AWS_REGION` | AWS chain/default | Bedrock region; `AWS_DEFAULT_REGION` and the active AWS profile are also supported by current Claude Code |
| `AWS_PROFILE` | `default` | AWS profile used by Claude Code; `~/.aws` persists on the container home volume |
| `AWS_BEARER_TOKEN_BEDROCK` | *(empty)* | Optional Bedrock API key; alternative to profile/access-key credentials |
| `ANTHROPIC_MODEL` | provider default | Optional default Bedrock model ID or inference-profile ARN; each task can override it |
| `POSTHOG_KEY` | *(empty)* | PostHog project API key. Set = product analytics on (browser snippet + server events). Empty = fully no-op, nothing is ever sent |
| `POSTHOG_HOST` | `https://us.i.posthog.com` | PostHog ingest host |
| `ORCH_ACCOUNT_ID` | *(empty)* | The `distinct_id` analytics events are keyed by. Empty = `self-hosted` |

Example — relocate an instance entirely via env:

```bash
PORT=8080 PTY_PORT=8081 \
PUBLIC_BASE_URL=https://orch.example.com \
ORCH_DB_DIR=/data/orchestrator \
ORCH_WORKTREES_DIR=/data/worktrees \
CLAUDE_CLI_PATH=/usr/local/bin/claude \
npm start
```

## Notes & caveats

- **Permissions:** sessions run with `permissionMode: "bypassPermissions"`
  (`lib/agents/claude/driver.ts`) so they don't block on prompts. Switch to
  `"acceptEdits"` for a safety gate.
- **Parallel quota:** every concurrent task spends your rate limit — N tasks ≈ N× the
  token rate against one subscription.
- **Terminal:** the `node-pty` sidecar stays bound to `127.0.0.1` only — the browser
  reaches it through the app origin at `/pty`, so remote access goes through your one
  tunneled hostname. `postinstall` restores the exec bit npm can strip off node-pty's
  prebuilt helper.
- **Keep `ANTHROPIC_API_KEY` unset** unless you deliberately chose the wizard's API-key
  path — set, it takes precedence and bills per-use instead of using your subscription.
- **Delete is hard delete:** a removed project's chat history is gone (your code on disk
  is untouched).
