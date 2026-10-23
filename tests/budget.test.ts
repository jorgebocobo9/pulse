import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { estimateCostUsd, getSpendForDate, isOverBudget, recordUsage } from '../src/services/budget.js';

describe('estimateCostUsd', () => {
  it('prices Haiku 5.5 at $0.10 input and $0.50 output per million tokens', () => {
    expect(estimateCostUsd('claude-haiku-5-5', 1_000_000, 0)).toBeCloseTo(0.1);
    expect(estimateCostUsd('claude-haiku-5-5', 0, 1_000_000)).toBeCloseTo(0.5);
    expect(estimateCostUsd('claude-haiku-5-5', 10_000, 500)).toBeCloseTo(0.00125);
  });

  it('throws for a model without a price', () => {
    expect(() => estimateCostUsd('claude-unknown', 1, 1)).toThrow(/No price/);
  });
});

describe('recordUsage', () => {
  it('stores the usage with its estimated cost', () => {
    const db = openDatabase(':memory:');
    const cost = recordUsage(db, { date: '2026-06-30', model: 'claude-haiku-5-5', inputTokens: 10_000, outputTokens: 500 });
    expect(cost).toBeCloseTo(0.00125);
    expect(db.prepare('SELECT date, model, input_tokens, output_tokens, est_cost_usd FROM usage_log').get()).toEqual({
      date: '2026-06-30',
      model: 'claude-haiku-5-5',
      input_tokens: 10_000,
      output_tokens: 500,
      est_cost_usd: cost,
    });
  });
});

describe('daily budget', () => {
  it('adds up spend for one UTC day only and blocks once the limit is reached', () => {
    const db = openDatabase(':memory:');
    const record = (date: string, inputTokens: number) =>
      recordUsage(db, { date, model: 'claude-haiku-5-5', inputTokens, outputTokens: 0 });

    expect(getSpendForDate(db, '2026-06-30')).toBe(0);
    expect(isOverBudget(db, '2026-06-30', 1)).toBe(false);

    record('2026-06-30', 6_000_000); // $0.60
    record('2026-06-29', 9_000_000); // $0.90, yesterday
    expect(getSpendForDate(db, '2026-06-30')).toBeCloseTo(0.6);
    expect(isOverBudget(db, '2026-06-30', 1)).toBe(false);

    record('2026-06-30', 4_000_000); // total $1.00
    expect(isOverBudget(db, '2026-06-30', 1)).toBe(true);
    expect(isOverBudget(db, '2026-07-01', 1)).toBe(false);
  });
});
