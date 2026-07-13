# Security policy

Orchestrator hands its user a full shell (the integrated terminal) and runs
coding agents with `bypassPermissions` in the projects you point it at. That
is the intended, documented trust model for a **single-user instance on your
own machine** — the app itself is not a sandbox.

Things we DO consider vulnerabilities:

- Reaching the app, the terminal (`/pty`), or the agent endpoints **without**
  passing the configured origin auth (Cloudflare Access mode) or the
  `SERVICE_TOKEN` gates.
- Cross-origin attacks against a default local instance (e.g. a malicious
  website driving `http://localhost:3000` from the browser — CSRF/DNS
  rebinding).
- One project's task escaping its git worktree isolation in a way the UI does
  not surface.
- Secrets (tokens, API keys) leaking into transcripts, logs, or diffs beyond
  what the user pasted themselves.

## Reporting

Please report vulnerabilities privately via GitHub Security Advisories
("Report a vulnerability" on the repo) rather than a public issue. You should
get a response within a few days.
