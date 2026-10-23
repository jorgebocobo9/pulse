import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import type { Campaign } from '../db/queries.js';
import { addDays } from '../dates.js';

export const APPROVAL_TTL_MS = 30 * 60 * 1000;

export type ApprovalAction = 'pause' | 'resume';
export type ApprovalStatus = 'pending' | 'approved' | 'cancelled' | 'expired';
export type Decision = 'approve' | 'cancel';

export interface Approval {
  id: string;
  action: ApprovalAction;
  campaignId: number;
  campaignName: string;
  reason: string;
  requestedBy: string;
  status: ApprovalStatus;
  decidedBy: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  channelId: string;
  threadTs: string | null;
  messageTs: string | null;
}

export interface ApprovalRequest {
  action: ApprovalAction;
  campaign: Campaign;
  reason: string;
  requestedBy: string;
  channelId: string;
  threadTs: string | undefined;
  now: Date;
}

export type CreateOutcome = { kind: 'created'; approval: Approval } | { kind: 'already_in_state'; campaign: Campaign };

export type DecisionOutcome =
  | { kind: 'not_found' }
  | { kind: 'not_allowed'; decision: Decision; approval: Approval }
  | { kind: 'already_decided'; approval: Approval }
  | { kind: 'expired'; approval: Approval }
  | { kind: 'approved'; approval: Approval }
  | { kind: 'no_change'; approval: Approval }
  | { kind: 'cancelled'; approval: Approval };

export interface ActionLogEntry {
  action: ApprovalAction;
  campaign: string;
  /** A pending request past its expiry time is reported as expired. */
  status: ApprovalStatus;
  reason: string;
  requestedBy: string;
  decidedBy: string | null;
  requestedAt: string;
  decidedAt: string | null;
  expiresAt: string;
}

const TARGET_STATUS: Record<ApprovalAction, Campaign['status']> = { pause: 'paused', resume: 'active' };

const selectApproval = `
  SELECT a.id, a.action, a.campaign_id AS campaignId, c.name AS campaignName, a.reason,
         a.requested_by AS requestedBy, a.status, a.decided_by AS decidedBy, a.created_at AS createdAt,
         a.expires_at AS expiresAt, a.decided_at AS decidedAt, a.channel_id AS channelId,
         a.thread_ts AS threadTs, a.message_ts AS messageTs
  FROM approvals a JOIN campaigns c ON c.id = a.campaign_id`;

export function getApproval(db: Db, id: string): Approval | undefined {
  return db.prepare<[string], Approval>(`${selectApproval} WHERE a.id = ?`).get(id);
}

/** Records a pending request. Nothing about the campaign changes until someone approves it. */
export function createApproval(db: Db, request: ApprovalRequest): CreateOutcome {
  const { action, campaign, now } = request;
  if (campaign.status === TARGET_STATUS[action]) return { kind: 'already_in_state', campaign };

  const id = randomUUID();
  db.prepare(
    `INSERT INTO approvals (id, action, campaign_id, reason, requested_by, status, created_at, expires_at, channel_id, thread_ts)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
  ).run(
    id,
    action,
    campaign.id,
    request.reason,
    request.requestedBy,
    now.toISOString(),
    new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
    request.channelId,
    request.threadTs ?? null,
  );
  return { kind: 'created', approval: getApproval(db, id)! };
}

/** Remembers which Slack message shows the request, so its buttons can be replaced later. */
export function setApprovalMessageTs(db: Db, id: string, messageTs: string): void {
  db.prepare('UPDATE approvals SET message_ts = ? WHERE id = ?').run(messageTs, id);
}

/**
 * Applies an Approve or Cancel click. Runs in one transaction, and the request is claimed with
 * `WHERE status = 'pending'`, so a double click, or two approvers clicking at once, can only act once.
 */
export function decideApproval(
  db: Db,
  input: { approvalId: string; decision: Decision; userId: string; approverIds: readonly string[]; now: Date },
): DecisionOutcome {
  const { approvalId, decision, userId, approverIds } = input;
  const now = input.now.toISOString();

  return db.transaction((): DecisionOutcome => {
    const approval = getApproval(db, approvalId);
    if (!approval) return { kind: 'not_found' };

    const isApprover = approverIds.includes(userId);
    const allowed = decision === 'approve' ? isApprover : isApprover || userId === approval.requestedBy;
    if (!allowed) return { kind: 'not_allowed', decision, approval };

    const claimed =
      db
        .prepare(
          `UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?
           WHERE id = ? AND status = 'pending' AND expires_at > ?`,
        )
        .run(decision === 'approve' ? 'approved' : 'cancelled', userId, now, approvalId, now).changes === 1;

    if (!claimed) {
      if (approval.status !== 'pending') return { kind: 'already_decided', approval };
      // Still pending but not claimable, so it has expired.
      db.prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ?").run(now, approvalId);
      audit(db, approval, 'expire', 'system', 'Expired after 30 minutes without a decision.', now);
      return { kind: 'expired', approval: getApproval(db, approvalId)! };
    }

    if (decision === 'cancel') {
      audit(db, approval, 'cancel', userId, null, now);
      return { kind: 'cancelled', approval: getApproval(db, approvalId)! };
    }

    const target = TARGET_STATUS[approval.action];
    const changed =
      db.prepare('UPDATE campaigns SET status = ? WHERE id = ? AND status != ?').run(target, approval.campaignId, target)
        .changes === 1;
    if (!changed) {
      // Someone else already made this change, so there is nothing to approve.
      db.prepare("UPDATE approvals SET status = 'cancelled' WHERE id = ?").run(approvalId);
      audit(db, approval, 'cancel', userId, `Campaign was already ${target}; nothing changed.`, now);
      return { kind: 'no_change', approval: getApproval(db, approvalId)! };
    }

    audit(db, approval, approval.action, userId, approval.reason, now);
    return { kind: 'approved', approval: getApproval(db, approvalId)! };
  })();
}

/** Approval requests made in the last `days` days (UTC, including today), newest first. */
export function getActionLog(
  db: Db,
  options: { days: number; status?: ApprovalStatus; today: string; now: Date },
): ActionLogEntry[] {
  const since = `${addDays(options.today, -(options.days - 1))}T00:00:00.000Z`;
  const now = options.now.toISOString();
  return db
    .prepare<[string], Approval>(`${selectApproval} WHERE a.created_at >= ? ORDER BY a.created_at DESC LIMIT 50`)
    .all(since)
    .map((a) => ({
      action: a.action,
      campaign: a.campaignName,
      status: a.status === 'pending' && a.expiresAt <= now ? 'expired' : a.status,
      reason: a.reason,
      requestedBy: a.requestedBy,
      decidedBy: a.decidedBy,
      requestedAt: a.createdAt,
      decidedAt: a.decidedAt,
      expiresAt: a.expiresAt,
    }))
    .filter((entry) => !options.status || entry.status === options.status);
}

function audit(
  db: Db,
  approval: Approval,
  action: ApprovalAction | 'cancel' | 'expire',
  performedBy: string,
  details: string | null,
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO audit_log (approval_id, action, campaign_id, performed_by, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(approval.id, action, approval.campaignId, performedBy, details, createdAt);
}
