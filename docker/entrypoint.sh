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
  "$HOME/.claude" \
  "$HOME/.aws"

# Subscription login by default. If an agent key/token env var is present, the
# `claude`/`codex` CLIs (and the Agent SDK child processes, and every pty shell
# — all inherit this environment) prefer it over the volume's stored login and
# silently switch to per-token API billing. Strip them so a stray `-e` on
# `docker run` can never do that — unless ORCH_ALLOW_API_KEY_ENV=1 explicitly
# opts in to env-provided keys. Both node entrypoints repeat this strip
# in-process (lib/env-keys.mjs) so bare-node deploys get the same guard; this
# is the container backstop. See docs/DEPLOY.md → "Per-user claude login".
if [[ "${ORCH_ALLOW_API_KEY_ENV:-}" != "1" && "${ORCH_ALLOW_API_KEY_ENV:-}" != "true" ]]; then
  for _v in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY; do
    if [[ -n "${!_v:-}" ]]; then
      echo "WARN: $_v was set in the container environment — unsetting it." \
           "Instances authenticate via the connected agent login (or a key saved in Settings);" \
           "set ORCH_ALLOW_API_KEY_ENV=1 to bill an environment-provided key on purpose." >&2
      unset "$_v"
    fi
  done
fi

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
