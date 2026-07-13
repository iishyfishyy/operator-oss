# syntax=docker/dockerfile:1
# Agent Orchestrator — one container per user (see docs/DEPLOY.md).
#
# The image bundles Node, git, and the `claude` CLI, and runs BOTH processes
# (Next.js custom server + node-pty terminal sidecar) via docker/entrypoint.sh.
# It is a PRODUCTION build (next build; NODE_ENV=production) so a stopped
# container wakes in seconds, not a dev-mode cold compile.
#
# All per-user state lives under /home/orch — mount one named volume there:
#   .zen-orchestrator/  SQLite db        worktrees/  per-task git worktrees
#   projects/           cloned repos     .claude/    claude CLI login (Max)
#   .config/gh/         gh CLI login     .gitconfig  git credential helper
#
# Build:  docker build -t agent-orchestrator .
# Run:    see docker-compose.yml or the reference `docker run` in docs/DEPLOY.md.

# ---- build stage: install all deps (incl. dev), compile Next ----------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Toolchain only as a fallback — better-sqlite3 and node-pty ship Linux x64
# prebuilds; node-gyp kicks in (and needs these) only when no prebuild matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# scripts/ first: postinstall runs scripts/fix-pty.js.
# .npmrc carries legacy-peer-deps=true (@xterm/addon-web-links@0.11 only
# declares a peer on @xterm/xterm@^5 but works with the v6 we pin).
COPY package.json package-lock.json .npmrc ./
COPY scripts ./scripts
RUN npm ci

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Drop dev deps from node_modules, then restore node-pty's spawn-helper exec
# bit (prune can re-extract prebuilds without it — same reason as postinstall).
RUN npm prune --omit=dev && node scripts/fix-pty.js

# ---- runtime stage -----------------------------------------------------------
FROM node:22-bookworm-slim

# git: project repos + per-task worktrees.  openssh-client: git over ssh.
# tini: PID 1 (reaps the pty shells' orphans).  procps: ps for debugging shells.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       git openssh-client ca-certificates curl bash tini procps \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI: powers the in-app "Connect GitHub" device-flow login and the
# repo picker/clone in project creation. Its token (~/.config/gh/hosts.yml)
# and the git credential helper it configures (~/.gitconfig) live on the home
# volume, so a login survives container stop/start.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/* \
  && gh --version

# The `claude` CLI (Agent SDK spawns it; login state lives in ~/.claude on the
# volume). Pinned location via CLAUDE_CLI_PATH; updates ship as image rebuilds,
# so the in-place autoupdater is disabled.
RUN npm install -g @anthropic-ai/claude-code && claude --version

# The `codex` CLI (the Codex agent driver drives it via @openai/codex-sdk; login
# state lives in ~/.codex on the volume). Installed globally so CODEX_CLI_PATH /
# PATH lookup and the auth helpers resolve it next to `claude`.
RUN npm install -g @openai/codex && codex --version

# Replace the base image's `node` user so uid 1000 owns /home/orch — named
# volumes initialize from this skeleton with correct ownership on first mount.
RUN userdel -r node \
  && useradd --create-home --uid 1000 --home-dir /home/orch --shell /bin/bash orch \
  && mkdir -p /home/orch/.zen-orchestrator /home/orch/worktrees /home/orch/projects /home/orch/.claude /home/orch/.codex \
  && chown -R orch:orch /home/orch

WORKDIR /app
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/.next ./.next
COPY --from=build --chown=root:root /app/public ./public
COPY --from=build --chown=root:root /app/server.js /app/pty-server.js /app/next.config.mjs /app/package.json ./
# server.js dynamically imports the origin auth verifier and the service
# hostname router at runtime (un-bundled, unlike the middleware copy compiled
# into .next). Import graphs: lib/auth/origin.mjs -> lib/cf-access.mjs;
# lib/service-router.mjs -> lib/service-host.mjs.
COPY --from=build --chown=root:root /app/lib/cf-access.mjs /app/lib/service-router.mjs /app/lib/service-host.mjs ./lib/
COPY --from=build --chown=root:root /app/lib/auth ./lib/auth
# The stdio MCP bridge the non-Claude drivers spawn per turn (node scripts/orch-mcp.mjs)
# and its shared tool defs — plain-Node .mjs the build output doesn't bundle, so
# they must be COPY'd explicitly (same gotcha as the auth/router .mjs above).
COPY --from=build --chown=root:root /app/scripts/orch-mcp.mjs ./scripts/orch-mcp.mjs
COPY --from=build --chown=root:root /app/lib/agentToolDefs.mjs ./lib/agentToolDefs.mjs
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/orch-entrypoint

# HOSTNAME is explicit because Docker injects the container id as $HOSTNAME,
# which would otherwise become server.js's bind address. 0.0.0.0 is correct
# INSIDE the container; isolation comes from publishing on the host's loopback
# only (-p 127.0.0.1:<port>:3000) with Cloudflare Tunnel in front.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOME=/home/orch \
    SHELL=/bin/bash \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    PTY_HOST=127.0.0.1 \
    PTY_PORT=3001 \
    ORCH_WORKTREES_DIR=/home/orch/worktrees \
    CLAUDE_CLI_PATH=/usr/local/bin/claude \
    CODEX_CLI_PATH=/usr/local/bin/codex \
    DISABLE_AUTOUPDATER=1

USER orch
EXPOSE 3000
VOLUME ["/home/orch"]

# Build provenance. orch-user.sh passes --build-arg GIT_SHA/BUILT_AT, captured
# from the deploy host's git tree BEFORE rsync (the image has no .git). Exposed
# read-only at GET /api/version so a deploy can be confirmed without ssh. Kept
# late so the per-build SHA churn doesn't bust any earlier layer's cache.
ARG GIT_SHA=unknown
ARG BUILT_AT=unknown
ENV ORCH_GIT_SHA=$GIT_SHA \
    ORCH_BUILT_AT=$BUILT_AT

# The idle endpoint doubles as the health probe (it exercises Next + SQLite).
# It presents SERVICE_TOKEN — the one path middleware.ts exempts from the
# Cloudflare Access check, since no Access JWT exists inside the container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/instance/idle',{headers:process.env.SERVICE_TOKEN?{'x-service-token':process.env.SERVICE_TOKEN}:{}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["tini", "--", "/usr/local/bin/orch-entrypoint"]
