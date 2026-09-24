# Changelog

All notable changes to Operator are documented here.

## [0.2.0] - 2026-09-24

- Organize suggestions by the task that proposed them, edit them in the transcript, and
  accept or start a whole dependency chain at once. Agents ask before filing unsolicited tasks.
- Save reusable prompts as custom slash commands.
- Discover available Claude and Codex models from connected agents, refresh the catalog,
  and pin exact model versions, including Claude Opus 5.5.
- Connect Claude through Amazon Bedrock, including AWS SSO sign-in from the app.
- Choose an opt-in Full access permission mode for Codex tasks.
- Inspect captured agent prompts with the optional prompt-debugging view.
- Improve `/clear` handoffs and session-versus-lifetime usage reporting; fix missing
  progress indicators after questions and stale conflict-resolution banners.

## [0.1.0] - 2026-08-19

Operator's first public release turns Claude Code and Codex into a browser-based workspace
for parallel coding-agent work.

### Highlights

- Run each task in its own git worktree, branch, transcript, and agent session.
- Chain tasks with dependencies, branch work into parallel paths, and automatically start
  tasks when their blockers finish.
- Review diffs beside the conversation, sync stale branches, resolve conflicts, merge, or
  open a GitHub pull request.
- See every task that needs input across projects from one inbox.
- Keep project context and task history across browser reloads and fresh context windows.
- Use Claude Code and OpenAI Codex with subscription login or an explicitly configured API
  key.
- Work from the built-in terminal, run managed services, and inspect token and usage data.
- Run Operator on your own computer, deploy it to a server you control, or use the hosted
  version from any browser.

[0.1.0]: https://github.com/iishyfishyy/operator-oss/releases/tag/v0.1.0

[0.2.0]: https://github.com/iishyfishyy/operator-oss/compare/v0.1.0...v0.2.0
