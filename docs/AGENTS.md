# Supported agents

Operator supports Claude Code and OpenAI Codex as first-class task agents. You can connect
either one or both, choose a default, and override the agent for an individual task.

## Support matrix

| Agent | Authentication | Task support | Notes |
|-|-|-|-|
| Claude Code | Max/Pro login or optional API key | Full | Reference driver; supports interactive questions and reported cost data |
| OpenAI Codex | ChatGPT login or optional API key | Full | Supports interactive questions through Operator's bridge; estimated cost data |

Connecting either agent completes first-run setup and makes it the initial default. The
app never requires Claude when only Codex is connected, or vice versa. Project recaps,
context drafts, and other utility jobs prefer a connected agent automatically.

## Authentication and billing

The recommended path is the subscription login offered by the first-run wizard or
**Settings → Agents**. Subscription turns consume plan quota and have no marginal API
charge. Operator removes stray `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` values from its
launch environment by default so an inherited shell variable cannot silently switch a
session to API billing.

If you intentionally want API-key billing, connect a key in the app or set
`ORCH_ALLOW_API_KEY_ENV=1` for a deliberately configured headless environment.

## Claude Code

Claude Code is the reference driver and the first target for new agent-facing features.
It supports parallel tasks, resume and `/clear` lineage, interactive questions, project
context, diff workflows, and usage reporting.

Task sessions run unattended inside their isolated worktrees. Operator is a control layer,
not an additional security sandbox; review [the security model](../SECURITY.md) before
exposing an instance.

### Amazon Bedrock

Claude can instead run entirely through **Amazon Bedrock**. Configure the normal AWS
credential chain (or `AWS_BEARER_TOKEN_BEDROCK`), set `CLAUDE_CODE_USE_BEDROCK=1` plus an
AWS region, restart Operator, then choose **Amazon Bedrock → Verify** under
**Settings → Agents**. Docker Compose forwards the documented Bedrock/AWS variables and
persists `~/.aws`; see [`.env.example`](../.env.example). Operator uses one Claude provider
per instance, so Bedrock and a Claude subscription are not mixed within the same instance.

On Bedrock the model picker offers the aliases your AWS config maps
(`ANTHROPIC_DEFAULT_OPUS_MODEL` etc.) plus a custom-model field for Bedrock ids and
inference-profile ARNs, and when your setup uses AWS IAM Identity Center (SSO), an expired
session is refreshed from the UI with a click-to-approve device link — no shell needed.
Full walkthrough: [Bedrock instructions](BEDROCK_INSTRUCTIONS.md).

## OpenAI Codex

Codex supports parallel tasks, diff review and merge, `/clear` lineage, project context,
interactive questions, and usage tracking. Operator supplies interactive questions through
its MCP bridge because the upstream non-interactive CLI does not provide that hook itself.

Two upstream differences are visible:

- ChatGPT-plan authentication reports tokens but not dollar cost, so Operator estimates
  the API-price equivalent and marks it with `~`.
- The non-interactive CLI cannot pause an active turn for a command-approval prompt.
  Operator therefore offers Auto-run and read-only Plan modes for Codex rather than a
  mid-turn approval mode, and asks Codex not to require approvals
  (`approval_policy=never`). If an enterprise-managed Codex configuration disallows
  that, Operator detects the CLI's downgrade warning on the first affected turn and
  switches itself to the compatible `on-request` policy automatically — the failed
  turn gets a one-click Retry. `CODEX_APPROVAL_POLICY` remains the manual override.

## Adding another agent

The app is agent-agnostic behind a small driver interface. A new driver supplies normalized
stream events and a capability descriptor; shared routing, transcripts, task state, and UI
controls consume that contract.

See [Architecture: the agent-driver seam](ARCHITECTURE.md#the-agent-driver-seam-libagents)
for the implementation guide. Proposals for another agent are welcome in
[GitHub Discussions](https://github.com/iishyfishyy/operator-oss/discussions/categories/ideas).
