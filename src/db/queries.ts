import { addDays } from '../dates.js';
import type { Db } from './client.js';
import type { CampaignStatus } from './generator.js';

export interface Campaign {
  id: number;
  name: string;
  platform: string;
  status: CampaignStatus;
  dailyBudget: number;
}

export type CampaignMatch =
  | { kind: 'found'; campaign: Campaign }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'not_found'; allNames: string[] };

export interface CampaignStats {
  campaign: string;
  status: CampaignStatus;
  from: string;
  to: string;
  days: number;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  revenue: number;
  /** Click-through rate as a percentage. Null when there were no impressions. */
  ctr: number | null;
  /** Cost per lead. Null when there were no leads. */
  cpl: number | null;
  /** Return on ad spend (revenue / spend). Null when there was no spend. */
  roas: number | null;
}

export type CompareMetric = 'cpl' | 'roas' | 'ctr' | 'spend';

const campaignColumns = 'id, name, platform, status, daily_budget AS dailyBudget';

export function listCampaigns(db: Db, status?: CampaignStatus): Campaign[] {
  return db
    .prepare<[CampaignStatus | null, CampaignStatus | null], Campaign>(
      `SELECT ${campaignColumns} FROM campaigns WHERE ? IS NULL OR status = ? ORDER BY id`,
    )
    .all(status ?? null, status ?? null);
}

/** Case-insensitive lookup: an exact name match wins, otherwise a single substring match. */
export function findCampaign(db: Db, query: string): CampaignMatch {
  const campaigns = listCampaigns(db);
  const needle = query.trim().toLowerCase();

  const exact = campaigns.find((c) => c.name.toLowerCase() === needle);
  if (exact) return { kind: 'found', campaign: exact };

  const partial = needle ? campaigns.filter((c) => c.name.toLowerCase().includes(needle)) : [];
  if (partial.length === 1) return { kind: 'found', campaign: partial[0]! };
  if (partial.length > 1) return { kind: 'ambiguous', candidates: partial.map((c) => c.name) };
  return { kind: 'not_found', allNames: campaigns.map((c) => c.name) };
}

/** Totals and ratios for one campaign over the `days` days ending on `today`, including today. */
export function getCampaignStats(db: Db, campaignId: number, days: number, today: string): CampaignStats {
  const [stats] = aggregate(db, days, today, campaignId);
  if (!stats) throw new Error(`Campaign ${campaignId} does not exist`);
  return stats;
}

/** Every campaign's stats, best first. Campaigns with no value for the metric (null) come last. */
export function compareCampaigns(
  db: Db,
  metric: CompareMetric,
  days: number,
  today: string,
): Array<CampaignStats & { rank: number }> {
  // Lower is better for cost per lead; higher is better for everything else.
  const direction = metric === 'cpl' ? 1 : -1;
  return aggregate(db, days, today)
    .sort((a, b) => {
      const x = a[metric];
      const y = b[metric];
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      return (x - y) * direction;
    })
    .map((stats, i) => ({ rank: i + 1, ...stats }));
}

interface AggregateRow {
  name: string;
  status: CampaignStatus;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  revenue: number;
}

function aggregate(db: Db, days: number, today: string, campaignId?: number): CampaignStats[] {
  const from = addDays(today, -(days - 1));
  const rows = db
    .prepare<[string, string, number | null, number | null], AggregateRow>(
      `SELECT c.name, c.status,
              COALESCE(SUM(m.spend), 0) AS spend,
              COALESCE(SUM(m.impressions), 0) AS impressions,
              COALESCE(SUM(m.clicks), 0) AS clicks,
              COALESCE(SUM(m.leads), 0) AS leads,
              COALESCE(SUM(m.revenue), 0) AS revenue
       FROM campaigns c
       LEFT JOIN daily_metrics m ON m.campaign_id = c.id AND m.date BETWEEN ? AND ?
       WHERE ? IS NULL OR c.id = ?
       GROUP BY c.id
       ORDER BY c.id`,
    )
    .all(from, today, campaignId ?? null, campaignId ?? null);

  return rows.map((r) => ({
    campaign: r.name,
    status: r.status,
    from,
    to: today,
    days,
    spend: round2(r.spend),
    impressions: r.impressions,
    clicks: r.clicks,
    leads: r.leads,
    revenue: round2(r.revenue),
    ctr: ratio(r.clicks * 100, r.impressions),
    cpl: ratio(r.spend, r.leads),
    roas: ratio(r.revenue, r.spend),
  }));
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : round2(numerator / denominator);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
