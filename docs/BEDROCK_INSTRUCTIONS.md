# Using Claude through Amazon Bedrock

Operator supports one Claude provider per instance. Configure the instance for
either Amazon Bedrock or a Claude subscription/API key; do not mix them in the
same running instance.

These instructions assume you have just cloned Operator and want to run it
locally.

## Install and open the repository

```bash
cd operator-oss
npm install
```

Then choose one of the following authentication approaches.

## Approach 1: Bedrock API key

Set the Bedrock provider and AWS region in the shell that will launch Operator:

```bash
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION=us-east-1
```

Enter the Bedrock API key without putting it in shell history. In `zsh`:

```zsh
read -s "AWS_BEARER_TOKEN_BEDROCK?Bedrock API key: "
echo
export AWS_BEARER_TOKEN_BEDROCK
```

In `bash`:

```bash
read -rsp "Bedrock API key: " AWS_BEARER_TOKEN_BEDROCK
echo
export AWS_BEARER_TOKEN_BEDROCK
```

Start Operator from that same shell:

```bash
npm run dev
```

The exported values apply only to that shell session. If you persist them,
store the API key in an approved secret manager or private shell configuration;
never commit it to the repository.

## Approach 2: AWS SSO profile

This approach uses the standard AWS credential chain and does not require
`AWS_BEARER_TOKEN_BEDROCK`.

Make sure your company-provided `claude` AWS profile is configured in
`~/.aws/config`. Then add the Bedrock environment to
`~/.claude/settings.json`, preserving any other settings already in the file:

```json
{
  "env": {
    "CLAUDE_CODE_USE_BEDROCK": "1",
    "AWS_PROFILE": "claude",
    "AWS_REGION": "us-east-1"
  }
}
```

Refresh the SSO session:

```bash
aws sso login --profile claude --use-device-code --no-browser
```

Open the URL printed by the command and enter its device code. Confirm Claude
can start through Bedrock:

```bash
claude
```

If your company configuration automatically starts the SSO device flow when
Claude needs fresh credentials, that behavior remains available. Logging in
before starting Operator avoids requiring an interactive refresh from a
background request.

Start Operator:

```bash
npm run dev
```

When the SSO session expires, run the same `aws sso login` command again.

## Verify Bedrock in Operator

1. Open [http://localhost:3000](http://localhost:3000).
2. Go to **Settings → Agents → Amazon Bedrock**.
3. Select **Verify**.

Do not set `ANTHROPIC_API_KEY` or perform Claude subscription login on this
Operator instance while Bedrock is enabled.

## Choosing models on Bedrock

On Bedrock, Claude Code's bare family aliases (`opus`, `sonnet`, `haiku`)
resolve only when the corresponding mapping is set, so Operator's model picker
shows exactly what will work on this instance:

- **Default** — inherit the instance default (`ANTHROPIC_MODEL`, or whatever
  your AWS configuration selects). This is the safest choice.
- **Mapped aliases** — one entry per family you mapped via
  `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, or
  `ANTHROPIC_DEFAULT_HAIKU_MODEL` (in the environment or the
  `~/.claude/settings.json` env block), labeled with the id it resolves to.
- **Custom model** — any Bedrock model ID, cross-region inference profile ID,
  or application inference-profile ARN, typed into the picker's custom field.

## Refreshing an expired SSO session from the UI

With the SSO approach, turns start failing with `ExpiredToken`-style errors
when the session lapses; Operator parks queued messages and shows a reconnect
banner. When it knows how to refresh your credentials, the **Amazon Bedrock**
card offers **Refresh AWS sign-in**: it runs the refresh command server-side,
shows you the device-authorization link (and one-time code), and completes as
soon as you approve in the browser — nothing to paste back, no shell needed.

The refresh command is resolved from standard configuration, in order:

1. The `awsAuthRefresh` setting in `~/.claude/settings.json` — Claude Code's
   own hook for this, used verbatim if present. For example:

   ```json
   {
     "awsAuthRefresh": "aws sso login --profile claude --use-device-code --no-browser"
   }
   ```

2. Otherwise, if `AWS_PROFILE` is set (environment or the settings env block)
   and that profile is SSO-based in `~/.aws/config`, Operator runs
   `aws sso login --profile <name> --use-device-code --no-browser`.

Static-key and bearer-token setups have nothing to refresh interactively, so
the button does not appear; update the credentials and restart instead.

## What Operator inherits from your Claude settings

Operator runs turns through the Claude Agent SDK with the default setting
sources, exactly like running `claude` in a terminal: your user settings
(`~/.claude/settings.json`, including the env block this document configures),
each repository's project settings, and `CLAUDE.md` files all load. That is
what makes the Bedrock configuration apply — and it also means your personal
hooks, plugins, and telemetry settings apply to Operator's turns. If you keep
per-machine tooling in your user settings that you don't want agents in
worktrees to trigger, scope those entries in your own settings rather than
expecting Operator to filter them.
