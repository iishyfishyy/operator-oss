# Insights and usage

Operator shows what your agents process and what they ship without sending repository data
elsewhere. Open **Insights** from the top bar for daily usage, tasks shipped, and lines
merged to base, filterable by project and agent across 7-, 30-, and 90-day ranges.

## Reading the task chip

A task may show a chip such as `250k tok · 3.5M cached · ~$4.20`.

| Part | Meaning |
|-|-|
| `250k tok` | Prompt, completion, and context written into the prompt cache—the tokens processed for the first time |
| `3.5M cached` | Prompt-cache reads, usually the conversation so far being reused on later turns |
| `~$4.20` | Estimated API-price equivalent; the tilde indicates an estimate rather than a reported charge |

Cache reads can dominate the raw count in a long task but are not millions of tokens of new
work. Hover the chip for exact counts and the full breakdown.

### This session versus the task's lifetime

`/clear` ends the current session and starts the next one in a fresh context window. Once a
task has more than one session, the chip reads `this session · 12k tok · 1.2M cached · ~$0.40`
and counts only the current window, starting from zero the moment `/clear` finishes. The
tooltip then adds a **Lifetime** section: the totals across every session, plus how many
sessions there have been. Nothing is discarded on `/clear`: the project column's cost figure
and the Insights charts always sum the task's full lifetime.

While a task is still on its first session the chip carries no `this session` label, because
the session and the lifetime are the same numbers.

## Cost versus price equivalent

On a Max, Pro, or ChatGPT subscription login, turns consume plan quota. The displayed dollar
figure answers “what would these tokens cost at published API prices?”; it is not a bill and
the marginal API charge is zero.

With an API key, the amount represents billed API usage. Claude can report its SDK dollar
figure directly. Codex currently reports tokens only, so its amount is estimated from token
counts and published prices and carries a `~`.

## Operator overhead

Insights separates task activity from Operator's own convenience jobs, including:

- `/clear` handoff summaries;
- project recaps;
- project-context drafts; and
- agent connection verification.

This makes it possible to understand the quota spent on automation independently of the
work requested in task sessions. Settings shows the last 30 days of utility-job activity
and allows unattended background work to be disabled.

## Data handling

The dashboard is computed from the local SQLite database. Filtering happens in the browser;
task transcripts and repository contents are not uploaded for Insights.
