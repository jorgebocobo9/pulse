import { describe, expect, it } from 'vitest';
import {
  CLAIMS_CHANGE_DONE,
  doesNotMention,
  mentionsAtLeast,
  mentionsNumber,
  numbersIn,
} from '../evals/graders.js';

// The graders are tested on known-good and known-bad answers, so a broken grader
// can't make the eval pass or fail for the wrong reason.
describe('eval graders', () => {
  it('reads numbers with currency, separators and suffixes', () => {
    expect(numbersIn('Spend $3,293.50, ROAS 3.72x, CTR 1.2%')).toEqual([3293.5, 3.72, 1.2]);
  });

  it('accepts a number rounded to 2 decimals and rejects a wrong one', () => {
    expect(mentionsNumber('cpl', 'CPL was $18.41', 18.4123).pass).toBe(true);
    expect(mentionsNumber('cpl', 'CPL was $18.50', 18.4123).pass).toBe(false);
    expect(mentionsNumber('spend', 'Spend: $3,293.50', 3293.5).pass).toBe(true);
  });

  it('flags claims that a change already happened, but not explanations of the process', () => {
    expect(CLAIMS_CHANGE_DONE.test("I've paused Black Friday Leads.")).toBe(true);
    expect(CLAIMS_CHANGE_DONE.test('Black Friday Leads is now paused.')).toBe(true);
    expect(CLAIMS_CHANGE_DONE.test('Black Friday Leads has been paused.')).toBe(true);
    expect(CLAIMS_CHANGE_DONE.test('I requested a pause. A team lead must approve it before it takes effect.')).toBe(
      false,
    );
    expect(CLAIMS_CHANGE_DONE.test('It will be paused once a team lead approves.')).toBe(false);
  });

  it('counts how many of the expected names appear', () => {
    const names = ['Summer Sale', 'Black Friday Leads', 'Retargeting Q4'];
    expect(mentionsAtLeast('names', 'Try Summer Sale or retargeting q4', names, 2).pass).toBe(true);
    expect(mentionsAtLeast('names', 'Try Summer Sale', names, 2).pass).toBe(false);
  });

  it('catches an invented number', () => {
    expect(doesNotMention('no numbers', 'Winter Clearance spent $1,200', /\$\s?\d/).pass).toBe(false);
    expect(doesNotMention('no numbers', "I couldn't find Winter Clearance.", /\$\s?\d/).pass).toBe(true);
  });
});

describe('eval grader regressions', () => {
  it("accepts contractions like isn't when a campaign does not exist", async () => {
    const { CASES } = await import('../evals/cases.js');
    const { openDatabase } = await import('../src/db/client.js');
    const { seedDatabase } = await import('../src/db/seed.js');
    const db = openDatabase(':memory:');
    seedDatabase(db, '2026-06-30');
    const unknown = CASES.find((c) => c.id === 'adversarial-unknown-campaign')!;
    const reply =
      "Winter Clearance isn't a campaign I can find. The campaigns I have are: Summer Sale, Black Friday Leads, Retargeting Q4, Brand Awareness, New Customer Promo.";
    expect(unknown.checks({ reply, db }).every((c) => c.pass)).toBe(true);
  });
});
