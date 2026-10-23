import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db/client.js';
import { generateDailyMetrics } from '../src/db/generator.js';
import { compareCampaigns, findCampaign, getCampaignStats, listCampaigns } from '../src/db/queries.js';
import { seedDatabase } from '../src/db/seed.js';

const TODAY = '2026-06-30';

let db: Db;
beforeEach(() => {
  db = openDatabase(':memory:');
  seedDatabase(db, TODAY);
});

function idOf(name: string): number {
  const match = findCampaign(db, name);
  if (match.kind !== 'found') throw new Error(`no campaign ${name}`);
  return match.campaign.id;
}

describe('listCampaigns', () => {
  it('lists all campaigns, or only those with a given status', () => {
    expect(listCampaigns(db)).toHaveLength(5);
    expect(listCampaigns(db, 'paused').map((c) => c.name)).toEqual(['Brand Awareness']);
    expect(listCampaigns(db, 'active')).toHaveLength(4);
    expect(listCampaigns(db)[0]).toEqual({
      id: 1,
      name: 'Summer Sale',
      platform: 'Meta',
      status: 'active',
      dailyBudget: 500,
    });
  });
});

describe('findCampaign', () => {
  it('matches exact names case-insensitively', () => {
    const match = findCampaign(db, '  summer SALE ');
    expect(match.kind === 'found' && match.campaign.name).toBe('Summer Sale');
  });

  it('matches a unique part of a name', () => {
    const match = findCampaign(db, 'q4');
    expect(match.kind === 'found' && match.campaign.name).toBe('Retargeting Q4');
  });

  it('lists the candidates when a partial name matches more than one campaign', () => {
    expect(findCampaign(db, 'ar')).toEqual({
      kind: 'ambiguous',
      candidates: ['Retargeting Q4', 'Brand Awareness'],
    });
  });

  it('returns every name when nothing matches', () => {
    const match = findCampaign(db, 'Winter Clearance');
    expect(match.kind).toBe('not_found');
    expect(match.kind === 'not_found' && match.allNames).toHaveLength(5);
  });

  it('treats an empty query as not found', () => {
    expect(findCampaign(db, '  ').kind).toBe('not_found');
  });
});

describe('getCampaignStats', () => {
  it('sums the last N days including today and computes the ratios', () => {
    const id = idOf('Summer Sale');
    const window = generateDailyMetrics(TODAY)
      .filter((r) => r.campaignId === id)
      .slice(-7);
    const spend = window.reduce((s, r) => s + r.spend, 0);
    const leads = window.reduce((s, r) => s + r.leads, 0);
    const revenue = window.reduce((s, r) => s + r.revenue, 0);
    const impressions = window.reduce((s, r) => s + r.impressions, 0);
    const clicks = window.reduce((s, r) => s + r.clicks, 0);

    const stats = getCampaignStats(db, id, 7, TODAY);

    expect(stats).toMatchObject({ campaign: 'Summer Sale', from: '2026-06-24', to: TODAY, days: 7, leads, clicks, impressions });
    expect(stats.spend).toBeCloseTo(spend, 2);
    expect(stats.revenue).toBeCloseTo(revenue, 2);
    expect(stats.cpl).toBeCloseTo(spend / leads, 2);
    expect(stats.roas).toBeCloseTo(revenue / spend, 2);
    expect(stats.ctr).toBeCloseTo((clicks / impressions) * 100, 2);
  });

  it('covers only today when days is 1', () => {
    const id = idOf('Summer Sale');
    const today = generateDailyMetrics(TODAY).find((r) => r.campaignId === id && r.date === TODAY)!;
    const stats = getCampaignStats(db, id, 1, TODAY);
    expect(stats.from).toBe(TODAY);
    expect(stats.spend).toBe(today.spend);
    expect(stats.leads).toBe(today.leads);
  });

  it('returns null ratios instead of dividing by zero', () => {
    const stats = getCampaignStats(db, idOf('Brand Awareness'), 7, TODAY);
    expect(stats).toMatchObject({ status: 'paused', spend: 0, leads: 0, impressions: 0, cpl: null, roas: null, ctr: null });
  });

  it('returns zeros for a window with no data at all', () => {
    const stats = getCampaignStats(db, idOf('Summer Sale'), 7, '2030-01-31');
    expect(stats).toMatchObject({ spend: 0, leads: 0, cpl: null, roas: null, ctr: null });
  });

  it('throws for an unknown campaign id', () => {
    expect(() => getCampaignStats(db, 999, 7, TODAY)).toThrow(/does not exist/);
  });
});

describe('compareCampaigns', () => {
  it('ranks CPL from lowest to highest, with no-data campaigns last', () => {
    const ranked = compareCampaigns(db, 'cpl', 7, TODAY);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(ranked[0]!.campaign).toBe('Retargeting Q4');
    expect(ranked.at(-2)!.campaign).toBe('Black Friday Leads');
    expect(ranked.at(-1)).toMatchObject({ campaign: 'Brand Awareness', cpl: null });
  });

  it('ranks ROAS from highest to lowest', () => {
    const ranked = compareCampaigns(db, 'roas', 7, TODAY);
    expect(ranked[0]!.campaign).toBe('Retargeting Q4');
    const values = ranked.map((r) => r.roas).filter((v) => v !== null);
    expect(values).toEqual([...values].sort((a, b) => b - a));
    expect(ranked.at(-1)!.roas).toBeNull();
  });

  it('ranks spend from highest to lowest, keeping zero spend in the list', () => {
    const ranked = compareCampaigns(db, 'spend', 7, TODAY);
    expect(ranked[0]!.campaign).toBe('Black Friday Leads');
    expect(ranked.at(-1)).toMatchObject({ campaign: 'Brand Awareness', spend: 0 });
  });
});
