#!/usr/bin/env bash
# Container entrypoint: run BOTH orchestrator processes (Next.js custom server
# + node-pty sidecar) and die if either dies — the container's restart policy
# brings the pair back as a unit. tini is PID 1 above us and reaps orphans.
set -euo pipefail

# Recreate the per-user state layout. Named volumes copy the image's /home/orch
# skeleton on first mount, but an empty bind mount (or a pre-created volume)
# starts blank — this makes either work.
mkdir -p \
  "$HOME/.zen-orchestrator" \
  "${ORCH_WORKTREES_DIR:-$HOME/worktrees}" \
  "$HOME/projects" \
  "$HOME/.claude"

# Subscription login only. If an Anthropic key/token env var is present, the
# `claude` CLI (and the Agent SDK child processes, and every pty shell — all
# inherit this environment) prefers it over the volume's claude.ai login and
# silently switches to per-token API billing. Strip them so a stray `-e` on
# `docker run` can never do that. See docs/DEPLOY.md → "Per-user claude login".
for _v in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; do
  if [[ -n "${!_v:-}" ]]; then
    echo "WARN: $_v was set in the container environment — unsetting it." \
         "Instances authenticate via 'claude auth login' (subscription) only." >&2
    unset "$_v"
  fi
done

# Optional git identity for task worktree commits, settable per instance
# without entering the container. Never overrides one already on the volume.
if [[ -n "${GIT_USER_NAME:-}" ]] && ! git config --global user.name >/dev/null 2>&1; then
  git config --global user.name "$GIT_USER_NAME"
fi
if [[ -n "${GIT_USER_EMAIL:-}" ]] && ! git config --global user.email >/dev/null 2>&1; then
  git config --global user.email "$GIT_USER_EMAIL"
fi

cd /app

term() {
  kill "${PTY_PID:-}" "${APP_PID:-}" 2>/dev/null || true
}
trap term TERM INT

node pty-server.js &
PTY_PID=$!
node server.js &
APP_PID=$!

# First exit (or a signal) wins; take the other process down with it.
code=0
wait -n || code=$?
term
wait || true
exit "$code"
