// Estimated dollar cost for Codex turns. ChatGPT-plan auth reports token
// counts only (no dollar figure), so we estimate spend as token counts ×
// OpenAI's published API prices for the resolved model — the same
// "API-equivalent" framing the Insights dashboard already uses. The estimate
// flows into the ordinary usage/cost pipeline (task_usage.cost_usd), and the
// capability descriptor's costIsEstimated flag tells the UI to label it as
// an estimate rather than a billed amount.

import type { TurnUsage } from "../../types";

// Published API prices in USD per 1M tokens (developers.openai.com/api/docs/
// pricing). Cached input is OpenAI's standard 90% discount on input. Matched
// by longest prefix so dated/suffixed model ids ("gpt-5.1-codex-max-…") hit
// their family row; keep more-specific prefixes above shorter ones.
const PRICES: { prefix: string; input: number; cachedInput: number; output: number }[] = [
  { prefix: "gpt-5.1-codex-mini", input: 0.25, cachedInput: 0.025, output: 2.0 },
  { prefix: "gpt-5.1-codex-max", input: 1.25, cachedInput: 0.125, output: 10.0 },
  { prefix: "gpt-5.1-codex", input: 1.25, cachedInput: 0.125, output: 10.0 },
  { prefix: "gpt-5.1", input: 1.25, cachedInput: 0.125, output: 10.0 },
  { prefix: "gpt-5-codex", input: 1.25, cachedInput: 0.125, output: 10.0 },
  { prefix: "gpt-5-mini", input: 0.25, cachedInput: 0.025, output: 2.0 },
  { prefix: "gpt-5", input: 1.25, cachedInput: 0.125, output: 10.0 },
];

// The codex CLI's own default model, assumed when a task doesn't pick one
// (tasks.model = null → we omit the model override and the CLI runs its
// default). Used to resolve pricing and the resolved-model badge; bump when
// upstream changes its default.
export const DEFAULT_CODEX_MODEL = "gpt-5.1-codex-max";

/** The model a codex turn effectively runs: the task's choice, else the CLI default. */
export function resolveCodexModel(taskModel: string | null | undefined): string {
  return taskModel || DEFAULT_CODEX_MODEL;
}

/**
 * Estimate the dollar cost of a turn from its token counts. `input_tokens` is
 * the full prompt (cached tokens included, as the API reports it), so cached
 * reads are re-priced at the cached rate rather than double-counted. Unknown
 * models price at the CLI-default family so the estimate degrades gracefully
 * instead of silently reporting $0.
 */
export function estimateCostUsd(model: string, usage: Pick<TurnUsage, "input_tokens" | "output_tokens" | "cache_read_tokens">): number {
  const p = PRICES.find((r) => model.startsWith(r.prefix)) ?? PRICES.find((r) => DEFAULT_CODEX_MODEL.startsWith(r.prefix))!;
  const cached = Math.min(usage.cache_read_tokens, usage.input_tokens);
  const fresh = usage.input_tokens - cached;
  return (fresh * p.input + cached * p.cachedInput + usage.output_tokens * p.output) / 1_000_000;
}
