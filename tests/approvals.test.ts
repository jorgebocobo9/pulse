import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db/client.js';
import { findCampaign, type Campaign } from '../src/db/queries.js';
import { seedDatabase } from '../src/db/seed.js';
import {
  createApproval,
  decideApproval,
  getActionLog,
  getApproval,
  setApprovalMessageTs,
  type Approval,
  type ApprovalAction,
} from '../src/services/approvals.js';

const LEAD = 'ULEAD';
const BUYER = 'UBUYER';
const OTHER = 'UOTHER';
const APPROVERS = [LEAD];
const T0 = new Date('2026-06-30T10:00:00.000Z');
const minutesAfter = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

let db: Db;
beforeEach(() => {
  db = openDatabase(':memory:');
  seedDatabase(db, '2026-06-30');
});

function campaign(name: string): Campaign {
  const match = findCampaign(db, name);
  if (match.kind !== 'found') throw new Error(name);
  return match.campaign;
}

function request(action: ApprovalAction = 'pause', name = 'Black Friday Leads', now = T0): Approval {
  const outcome = createApproval(db, {
    action,
    campaign: campaign(name),
    reason: 'CPL is too high',
    requestedBy: BUYER,
    channelId: 'C1',
    threadTs: '111.222',
    now,
  });
  if (outcome.kind !== 'created') throw new Error('not created');
  return outcome.approval;
}

const decide = (approvalId: string, decision: 'approve' | 'cancel', userId: string, now = minutesAfter(5)) =>
  decideApproval(db, { approvalId, decision, userId, approverIds: APPROVERS, now });

const statusOf = (name: string) => campaign(name).status;
const auditRows = () =>
  db.prepare('SELECT action, performed_by AS performedBy, details FROM audit_log ORDER BY id').all();

describe('createApproval', () => {
  it('creates a pending request that expires in 30 minutes, without changing the campaign', () => {
    const approval = request();
    expect(approval).toMatchObject({
      action: 'pause',
      campaignName: 'Black Friday Leads',
      reason: 'CPL is too high',
      requestedBy: BUYER,
      status: 'pending',
      createdAt: '2026-06-30T10:00:00.000Z',
      expiresAt: '2026-06-30T10:30:00.000Z',
      channelId: 'C1',
      threadTs: '111.222',
      messageTs: null,
    });
    expect(statusOf('Black Friday Leads')).toBe('active');
  });

  it('refuses a request that would change nothing', () => {
    const outcome = createApproval(db, {
      action: 'pause',
      campaign: campaign('Brand Awareness'),
      reason: 'x',
      requestedBy: BUYER,
      channelId: 'C1',
      threadTs: undefined,
      now: T0,
    });
    expect(outcome.kind).toBe('already_in_state');
    expect(db.prepare('SELECT COUNT(*) FROM approvals').pluck().get()).toBe(0);
  });

  it('stores the Slack message that shows the request', () => {
    const approval = request();
    setApprovalMessageTs(db, approval.id, '333.444');
    expect(getApproval(db, approval.id)!.messageTs).toBe('333.444');
  });
});

describe('decideApproval', () => {
  it('pauses the campaign and writes an audit entry when an approver approves', () => {
    const approval = request();
    const outcome = decide(approval.id, 'approve', LEAD);

    expect(outcome.kind).toBe('approved');
    expect(outcome.kind === 'approved' && outcome.approval).toMatchObject({ status: 'approved', decidedBy: LEAD });
    expect(statusOf('Black Friday Leads')).toBe('paused');
    expect(auditRows()).toEqual([{ action: 'pause', performedBy: LEAD, details: 'CPL is too high' }]);
  });

  it('resumes a paused campaign', () => {
    const approval = request('resume', 'Brand Awareness');
    expect(decide(approval.id, 'approve', LEAD).kind).toBe('approved');
    expect(statusOf('Brand Awareness')).toBe('active');
  });

  it('runs the action only once when Approve is clicked twice', () => {
    const approval = request();
    expect(decide(approval.id, 'approve', LEAD).kind).toBe('approved');

    const second = decide(approval.id, 'approve', LEAD);
    expect(second.kind).toBe('already_decided');
    expect(second.kind === 'already_decided' && second.approval).toMatchObject({ status: 'approved', decidedBy: LEAD });
    expect(auditRows()).toHaveLength(1);
  });

  it('does not let a non-approver approve', () => {
    const approval = request();
    expect(decide(approval.id, 'approve', OTHER)).toMatchObject({ kind: 'not_allowed', decision: 'approve' });
    expect(decide(approval.id, 'approve', BUYER).kind).toBe('not_allowed');
    expect(getApproval(db, approval.id)!.status).toBe('pending');
    expect(statusOf('Black Friday Leads')).toBe('active');
  });

  it('lets the requester or an approver cancel, but nobody else', () => {
    const first = request();
    expect(decide(first.id, 'cancel', OTHER).kind).toBe('not_allowed');
    expect(decide(first.id, 'cancel', BUYER).kind).toBe('cancelled');

    const second = request();
    expect(decide(second.id, 'cancel', LEAD).kind).toBe('cancelled');

    expect(statusOf('Black Friday Leads')).toBe('active');
    expect(auditRows()).toEqual([
      { action: 'cancel', performedBy: BUYER, details: null },
      { action: 'cancel', performedBy: LEAD, details: null },
    ]);
  });

  it('cannot approve a cancelled request', () => {
    const approval = request();
    decide(approval.id, 'cancel', BUYER);
    expect(decide(approval.id, 'approve', LEAD).kind).toBe('already_decided');
    expect(statusOf('Black Friday Leads')).toBe('active');
  });

  it('expires a request after 30 minutes and records it', () => {
    const approval = request();
    const outcome = decide(approval.id, 'approve', LEAD, minutesAfter(30));

    expect(outcome.kind).toBe('expired');
    expect(getApproval(db, approval.id)!.status).toBe('expired');
    expect(statusOf('Black Friday Leads')).toBe('active');
    expect(auditRows()).toEqual([
      { action: 'expire', performedBy: 'system', details: 'Expired after 30 minutes without a decision.' },
    ]);
    // Clicking again reports the stored decision.
    expect(decide(approval.id, 'approve', LEAD, minutesAfter(31)).kind).toBe('already_decided');
  });

  it('changes nothing when the campaign was already changed by another request', () => {
    const first = request();
    const second = request();
    expect(decide(first.id, 'approve', LEAD).kind).toBe('approved');

    const outcome = decide(second.id, 'approve', LEAD);
    expect(outcome.kind).toBe('no_change');
    expect(getApproval(db, second.id)!.status).toBe('cancelled');
    expect(auditRows()).toHaveLength(2);
    expect(auditRows()[1]).toMatchObject({ action: 'cancel', details: 'Campaign was already paused; nothing changed.' });
  });

  it('reports an unknown request', () => {
    expect(decide('missing', 'approve', LEAD).kind).toBe('not_found');
  });
});

describe('getActionLog', () => {
  it('lists requests of every status, newest first, and reports overdue pending ones as expired', () => {
    const approved = request('pause', 'Black Friday Leads', T0);
    const cancelled = request('pause', 'Summer Sale', minutesAfter(1));
    request('resume', 'Brand Awareness', minutesAfter(2)); // left pending
    decide(approved.id, 'approve', LEAD);
    decide(cancelled.id, 'cancel', BUYER);

    const log = getActionLog(db, { days: 1, today: '2026-06-30', now: minutesAfter(10) });
    expect(log.map((e) => [e.campaign, e.status])).toEqual([
      ['Brand Awareness', 'pending'],
      ['Summer Sale', 'cancelled'],
      ['Black Friday Leads', 'approved'],
    ]);
    expect(log[2]).toMatchObject({ action: 'pause', requestedBy: BUYER, decidedBy: LEAD, reason: 'CPL is too high' });

    const later = getActionLog(db, { days: 1, today: '2026-06-30', now: minutesAfter(60) });
    expect(later[0]!.status).toBe('expired');
  });

  it('filters by status and by date', () => {
    const approval = request();
    decide(approval.id, 'approve', LEAD);

    expect(getActionLog(db, { days: 1, status: 'approved', today: '2026-06-30', now: T0 })).toHaveLength(1);
    expect(getActionLog(db, { days: 1, status: 'pending', today: '2026-06-30', now: T0 })).toHaveLength(0);
    expect(getActionLog(db, { days: 1, today: '2026-07-01', now: T0 })).toHaveLength(0);
    expect(getActionLog(db, { days: 2, today: '2026-07-01', now: T0 })).toHaveLength(1);
  });
});
