import type { Db } from './client.js';
import { CAMPAIGNS, generateDailyMetrics } from './generator.js';

export interface SeedResult {
  campaigns: number;
  metricRows: number;
}

/**
 * Resets campaigns to their starting state and rewrites 90 days of metrics ending on `endDate`.
 * Safe to re-run: approvals, the audit log, conversations and usage are never touched.
 */
export function seedDatabase(db: Db, endDate: string): SeedResult {
  const upsertCampaign = db.prepare(`
    INSERT INTO campaigns (id, name, platform, status, daily_budget)
    VALUES (@id, @name, @platform, @status, @dailyBudget)
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name,
      platform = excluded.platform,
      status = excluded.status,
      daily_budget = excluded.daily_budget
  `);
  const insertMetric = db.prepare(`
    INSERT INTO daily_metrics (campaign_id, date, spend, impressions, clicks, leads, revenue)
    VALUES (@campaignId, @date, @spend, @impressions, @clicks, @leads, @revenue)
  `);

  const metrics = generateDailyMetrics(endDate);
  db.transaction(() => {
    for (const { id, name, platform, status, dailyBudget } of CAMPAIGNS) {
      upsertCampaign.run({ id, name, platform, status, dailyBudget });
    }
    db.prepare('DELETE FROM daily_metrics').run();
    for (const row of metrics) insertMetric.run(row);
  })();

  return { campaigns: CAMPAIGNS.length, metricRows: metrics.length };
}
