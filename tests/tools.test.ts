import { beforeEach, describe, expect, it } from 'vitest';
import { runTool, TOOL_DEFINITIONS, type ToolContext } from '../src/agent/tools.js';
import { openDatabase } from '../src/db/client.js';
import { seedDatabase } from '../src/db/seed.js';
import { decideApproval, type Approval } from '../src/services/approvals.js';

const TODAY = '2026-06-30';
const NOW = new Date('2026-06-30T10:00:00.000Z');
let ctx: ToolContext;
let created: Approval[];

beforeEach(() => {
  const db = openDatabase(':memory:');
  seedDatabase(db, TODAY);
  created = [];
  ctx = {
    db,
    today: TODAY,
    now: NOW,
    request: { userId: 'UBUYER', channelId: 'C1', threadTs: '111.222' },
    onApprovalCreated: (approval) => created.push(approval),
  };
});

describe('TOOL_DEFINITIONS', () => {
  it('declares every tool in a fixed order with plain JSON Schemas', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual([
      'list_campaigns',
      'get_campaign_stats',
      'compare_campaigns',
      'get_action_log',
      'request_pause_campaign',
      'request_resume_campaign',
    ]);
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema).not.toHaveProperty('$schema');
    }
    expect(TOOL_DEFINITIONS[1]!.input_schema.required).toEqual(['campaign_name', 'days']);
    // Fields with defaults stay optional for Claude.
    expect(TOOL_DEFINITIONS[3]!.input_schema.required ?? []).toEqual([]);
    expect(TOOL_DEFINITIONS[4]!.input_schema.required).toEqual(['campaign_name', 'reason']);
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

describe('request tools', () => {
  it('create a pending approval for the person who asked, without changing the campaign', () => {
    const result = runTool('request_pause_campaign', { campaign_name: 'black friday', reason: 'CPL is too high' }, ctx);

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      status: 'approval_requested',
      action: 'pause',
      campaign: 'Black Friday Leads',
      expiresAt: '2026-06-30T10:30:00.000Z',
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ requestedBy: 'UBUYER', channelId: 'C1', threadTs: '111.222', status: 'pending' });
    expect(ctx.db.prepare("SELECT status FROM campaigns WHERE name = 'Black Friday Leads'").pluck().get()).toBe('active');
  });

  it('refuse a change that would do nothing', () => {
    const result = runTool('request_pause_campaign', { campaign_name: 'Brand Awareness', reason: 'x' }, ctx);
    expect(result).toEqual({
      content: 'Brand Awareness is already paused, so there is nothing to request.',
      isError: true,
    });
    expect(created).toHaveLength(0);
  });

  it('can resume a paused campaign', () => {
    const result = runTool('request_resume_campaign', { campaign_name: 'Brand Awareness', reason: 'New creative' }, ctx);
    expect(result.isError).toBe(false);
    expect(created[0]).toMatchObject({ action: 'resume', campaignName: 'Brand Awareness' });
  });

  it('require a reason', () => {
    expect(runTool('request_pause_campaign', { campaign_name: 'Summer Sale' }, ctx).isError).toBe(true);
    expect(runTool('request_pause_campaign', { campaign_name: 'Summer Sale', reason: '' }, ctx).isError).toBe(true);
  });

  it('only work from Slack', () => {
    const { request: _request, ...withoutRequest } = ctx;
    const result = runTool('request_pause_campaign', { campaign_name: 'Summer Sale', reason: 'x' }, withoutRequest);
    expect(result).toMatchObject({ isError: true, content: 'Campaign changes can only be requested from Slack.' });
  });
});

describe('get_action_log', () => {
  it('shows requests and their outcome, defaulting to today', () => {
    runTool('request_pause_campaign', { campaign_name: 'Black Friday Leads', reason: 'CPL is too high' }, ctx);
    decideApproval(ctx.db, {
      approvalId: created[0]!.id,
      decision: 'approve',
      userId: 'ULEAD',
      approverIds: ['ULEAD'],
      now: new Date('2026-06-30T10:05:00.000Z'),
    });

    const result = runTool('get_action_log', {}, ctx);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual([
      expect.objectContaining({ action: 'pause', campaign: 'Black Friday Leads', status: 'approved', decidedBy: 'ULEAD' }),
    ]);
    expect(JSON.parse(runTool('get_action_log', { status: 'pending' }, ctx).content)).toEqual([]);
  });
});
