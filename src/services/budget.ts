import { MODEL_PRICES } from '../config.js';
import type { Db } from '../db/client.js';

export interface Usage {
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = MODEL_PRICES[model];
  if (!price) throw new Error(`No price for model ${model}`);
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/** Records one API response's token usage and returns its estimated cost. */
export function recordUsage(db: Db, usage: Usage): number {
  const cost = estimateCostUsd(usage.model, usage.inputTokens, usage.outputTokens);
  db.prepare(
    'INSERT INTO usage_log (date, model, input_tokens, output_tokens, est_cost_usd) VALUES (?, ?, ?, ?, ?)',
  ).run(usage.date, usage.model, usage.inputTokens, usage.outputTokens, cost);
  return cost;
}
