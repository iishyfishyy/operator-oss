import type { TurnUsage } from "../../types";
import { estimateCostUsd } from "./pricing";

export interface CodexTokenUsage {
  input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  cached_input_tokens: number;
  // Added to the CLI's usage report after the driver shipped; optional so an
  // older `codex` binary that omits it prices as plain input.
  cache_write_input_tokens?: number;
}

/**
 * Normalize and price the token-only usage emitted by Codex. Codex folds cached
 * reads and cache writes into `input_tokens`; the app's contract keeps the three
 * buckets DISJOINT (matching Claude's), so they're netted out here rather than
 * double-counted in the task total and the context gauge. Reasoning output folds
 * into output_tokens — the API bills reasoning as output. Callers pass PER-TURN
 * counters: events.ts subtracts the thread's cumulative baseline first, and the
 * auth verify parser reads a fresh single-turn thread.
 */
export function codexUsage(u: CodexTokenUsage, model: string): TurnUsage {
  const cacheWrite = u.cache_write_input_tokens ?? 0;
  const usage = {
    cost_usd: 0,
    input_tokens: Math.max(0, u.input_tokens - u.cached_input_tokens - cacheWrite),
    output_tokens: u.output_tokens + u.reasoning_output_tokens,
    cache_read_tokens: u.cached_input_tokens,
    cache_creation_tokens: cacheWrite,
  };
  usage.cost_usd = estimateCostUsd(model, usage);
  return usage;
}
