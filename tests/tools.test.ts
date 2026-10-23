import { beforeEach, describe, expect, it } from 'vitest';
import { runTool, TOOL_DEFINITIONS, type ToolContext } from '../src/agent/tools.js';
import { openDatabase } from '../src/db/client.js';
import { seedDatabase } from '../src/db/seed.js';

const TODAY = '2026-06-30';
let ctx: ToolContext;

beforeEach(() => {
  const db = openDatabase(':memory:');
  seedDatabase(db, TODAY);
  ctx = { db, today: TODAY };
});

describe('TOOL_DEFINITIONS', () => {
  it('declares the read tools in a fixed order with plain JSON Schemas', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual(['list_campaigns', 'get_campaign_stats', 'compare_campaigns']);
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema).not.toHaveProperty('$schema');
    }
    expect(TOOL_DEFINITIONS[1]!.input_schema.required).toEqual(['campaign_name', 'days']);
  });
});

describe('runTool', () => {
  it('lists campaigns filtered by status', () => {
    const result = runTool('list_campaigns', { status: 'paused' }, ctx);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual([
      { id: 4, name: 'Brand Awareness', platform: 'Meta', status: 'paused', dailyBudget: 400 },
    ]);
  });

  it('returns stats for a campaign matched by part of its name', () => {
    const result = runTool('get_campaign_stats', { campaign_name: 'summer', days: 7 }, ctx);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({ campaign: 'Summer Sale', days: 7, from: '2026-06-24', to: TODAY });
  });

  it('lists the real names when the campaign does not exist', () => {
    const result = runTool('get_campaign_stats', { campaign_name: 'Winter Clearance', days: 7 }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No campaign matches "Winter Clearance"');
    expect(result.content).toContain('Summer Sale, Black Friday Leads, Retargeting Q4, Brand Awareness, New Customer Promo');
  });

  it('asks Claude to clarify when a name matches more than one campaign', () => {
    const result = runTool('get_campaign_stats', { campaign_name: 'ar', days: 7 }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Retargeting Q4, Brand Awareness');
  });

  it('rejects invalid input with a readable error', () => {
    const result = runTool('get_campaign_stats', { campaign_name: 'Summer Sale', days: 365 }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Invalid input/);
    expect(result.content).toMatch(/days/);

    expect(runTool('compare_campaigns', { metric: 'profit', days: 7 }, ctx).isError).toBe(true);
    expect(runTool('get_campaign_stats', { days: 7 }, ctx).isError).toBe(true);
  });

  it('ranks campaigns', () => {
    const result = runTool('compare_campaigns', { metric: 'roas', days: 7 }, ctx);
    const ranked = JSON.parse(result.content) as Array<{ rank: number; campaign: string }>;
    expect(ranked[0]).toMatchObject({ rank: 1, campaign: 'Retargeting Q4' });
  });

  it('reports an unknown tool as an error', () => {
    expect(runTool('delete_everything', {}, ctx)).toEqual({ content: 'Unknown tool: delete_everything', isError: true });
  });

  it('turns an unexpected exception into an error result instead of throwing', () => {
    ctx.db.close();
    const result = runTool('list_campaigns', {}, ctx);
    expect(result.isError).toBe(true);
    expect(result.failure).toBeInstanceOf(Error);
  });
});
