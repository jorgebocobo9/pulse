import { addDays } from '../dates.js';

export type CampaignStatus = 'active' | 'paused';

export interface CampaignDefinition {
  id: number;
  name: string;
  platform: string;
  status: CampaignStatus;
  dailyBudget: number;
  /** Cost per lead at the start and at the end of the window; days in between move linearly. */
  cplStart: number;
  cplEnd: number;
  revenuePerLead: number;
  /** The campaign has had no spend for this many days, counting back from the window's end date. */
  pausedForDays?: number;
}

export interface DailyMetric {
  campaignId: number;
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  revenue: number;
}

// Each campaign tells a different story so the demo has something to find.
export const CAMPAIGNS: readonly CampaignDefinition[] = [
  // Improving: CPL falls from about $32 to $18.
  { id: 1, name: 'Summer Sale', platform: 'Meta', status: 'active', dailyBudget: 500, cplStart: 32, cplEnd: 18, revenuePerLead: 65 },
  // Getting worse: CPL climbs from about $20 to $48.
  { id: 2, name: 'Black Friday Leads', platform: 'Meta', status: 'active', dailyBudget: 800, cplStart: 20, cplEnd: 48, revenuePerLead: 55 },
  // High ROAS: cheap leads that turn into high-value sales.
  { id: 3, name: 'Retargeting Q4', platform: 'Meta', status: 'active', dailyBudget: 300, cplStart: 14, cplEnd: 13, revenuePerLead: 120 },
  // Paused three weeks ago after poor results.
  { id: 4, name: 'Brand Awareness', platform: 'Meta', status: 'paused', dailyBudget: 400, cplStart: 55, cplEnd: 65, revenuePerLead: 40, pausedForDays: 21 },
  // Steady performer.
  { id: 5, name: 'New Customer Promo', platform: 'Google', status: 'active', dailyBudget: 350, cplStart: 26, cplEnd: 25, revenuePerLead: 70 },
];

/**
 * Generates `days` days of metrics for every campaign, ending on `endDate`.
 * Output depends only on the arguments: the random noise for a day is seeded by the campaign and date,
 * and each trend runs from the start to the end of the window.
 */
export function generateDailyMetrics(endDate: string, days = 90): DailyMetric[] {
  const rows: DailyMetric[] = [];
  for (const campaign of CAMPAIGNS) {
    for (let daysAgo = days - 1; daysAgo >= 0; daysAgo--) {
      const date = addDays(endDate, -daysAgo);
      const progress = days > 1 ? 1 - daysAgo / (days - 1) : 1;
      rows.push(
        daysAgo < (campaign.pausedForDays ?? 0)
          ? { campaignId: campaign.id, date, spend: 0, impressions: 0, clicks: 0, leads: 0, revenue: 0 }
          : generateDay(campaign, date, progress),
      );
    }
  }
  return rows;
}

function generateDay(campaign: CampaignDefinition, date: string, progress: number): DailyMetric {
  const random = mulberry32(hashString(`${campaign.id}:${date}`));
  const jitter = (spread: number) => 1 + (random() * 2 - 1) * spread;

  const spend = round2(campaign.dailyBudget * (0.88 + random() * 0.12));
  const costPerThousandImpressions = 9 * jitter(0.15);
  const impressions = Math.round((spend / costPerThousandImpressions) * 1000);
  const clicks = Math.round(impressions * 0.012 * jitter(0.2));
  const cpl = (campaign.cplStart + (campaign.cplEnd - campaign.cplStart) * progress) * jitter(0.12);
  const leads = Math.min(clicks, Math.round(spend / cpl));
  const revenue = round2(leads * campaign.revenuePerLead * jitter(0.15));

  return { campaignId: campaign.id, date, spend, impressions, clicks, leads, revenue };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// FNV-1a: turns a string into a 32-bit seed.
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// Mulberry32: a small seeded random number generator returning values in [0, 1).
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
