import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { CAMPAIGNS, generateDailyMetrics, type DailyMetric } from '../src/db/generator.js';
import { seedDatabase } from '../src/db/seed.js';

const END = '2026-06-30';

function rowsFor(name: string, rows: DailyMetric[]): DailyMetric[] {
  const id = CAMPAIGNS.find((c) => c.name === name)!.id;
  return rows.filter((r) => r.campaignId === id);
}

function cpl(rows: DailyMetric[]): number {
  const spend = rows.reduce((sum, r) => sum + r.spend, 0);
  const leads = rows.reduce((sum, r) => sum + r.leads, 0);
  return spend / leads;
}

function roas(rows: DailyMetric[]): number {
  return rows.reduce((sum, r) => sum + r.revenue, 0) / rows.reduce((sum, r) => sum + r.spend, 0);
}

describe('generateDailyMetrics', () => {
  const rows = generateDailyMetrics(END);

  it('produces 90 days for each of the 5 campaigns, ending on the end date', () => {
    expect(rows).toHaveLength(5 * 90);
    const summer = rowsFor('Summer Sale', rows);
    expect(summer[0]!.date).toBe('2026-04-02');
    expect(summer.at(-1)!.date).toBe(END);
  });

  it('is deterministic', () => {
    expect(generateDailyMetrics(END)).toEqual(rows);
  });

  it('keeps every day internally consistent', () => {
    for (const r of rows) {
      expect(r.clicks).toBeLessThanOrEqual(r.impressions);
      expect(r.leads).toBeLessThanOrEqual(r.clicks);
      expect(r.spend).toBeGreaterThanOrEqual(0);
    }
  });

  it('shows Summer Sale improving and Black Friday Leads getting worse', () => {
    const summer = rowsFor('Summer Sale', rows);
    const blackFriday = rowsFor('Black Friday Leads', rows);
    expect(cpl(summer.slice(-7))).toBeLessThan(cpl(summer.slice(0, 7)) * 0.75);
    expect(cpl(blackFriday.slice(-7))).toBeGreaterThan(cpl(blackFriday.slice(0, 7)) * 1.75);
  });

  it('gives Retargeting Q4 the highest ROAS', () => {
    const byRoas = CAMPAIGNS.filter((c) => c.status === 'active')
      .map((c) => ({ name: c.name, roas: roas(rowsFor(c.name, rows)) }))
      .sort((a, b) => b.roas - a.roas);
    expect(byRoas[0]!.name).toBe('Retargeting Q4');
  });

  it('has no spend for Brand Awareness in the last 21 days', () => {
    const brand = rowsFor('Brand Awareness', rows);
    expect(brand.slice(-21).every((r) => r.spend === 0 && r.leads === 0 && r.impressions === 0)).toBe(true);
    expect(brand.at(-22)!.spend).toBeGreaterThan(0);
  });
});

describe('seedDatabase', () => {
  it('can be re-run without touching approvals or the audit log', () => {
    const db = openDatabase(':memory:');
    seedDatabase(db, END);
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE name = 'Summer Sale'").run();
    db.prepare(
      `INSERT INTO approvals (id, action, campaign_id, requested_by, status, created_at, expires_at, channel_id)
       VALUES ('a1', 'pause', 1, 'U1', 'approved', '2026-06-30T10:00:00Z', '2026-06-30T10:30:00Z', 'C1')`,
    ).run();
    db.prepare(
      `INSERT INTO audit_log (approval_id, action, campaign_id, performed_by, created_at)
       VALUES ('a1', 'pause', 1, 'U2', '2026-06-30T10:05:00Z')`,
    ).run();

    const result = seedDatabase(db, '2026-07-01');

    expect(result).toEqual({ campaigns: 5, metricRows: 450 });
    expect(db.prepare('SELECT COUNT(*) FROM daily_metrics').pluck().get()).toBe(450);
    expect(db.prepare('SELECT MAX(date) FROM daily_metrics').pluck().get()).toBe('2026-07-01');
    expect(db.prepare("SELECT status FROM campaigns WHERE name = 'Summer Sale'").pluck().get()).toBe('active');
    expect(db.prepare('SELECT COUNT(*) FROM approvals').pluck().get()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM audit_log').pluck().get()).toBe(1);
  });
});
