import type { types } from '@slack/bolt';
import type { Approval, Decision, DecisionOutcome } from '../services/approvals.js';

export const APPROVE_ACTION_ID = 'approval_approve';
export const CANCEL_ACTION_ID = 'approval_cancel';

/** Escapes user-supplied text so it can't add formatting, links or mentions to a Slack message. */
export function escapeMrkdwn(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function summary(approval: Approval): string {
  const verb = approval.action === 'pause' ? 'Pause' : 'Resume';
  return [
    `*${verb} ${escapeMrkdwn(approval.campaignName)}*`,
    `*Reason:* ${escapeMrkdwn(approval.reason)}`,
    `*Requested by:* <@${approval.requestedBy}>`,
  ].join('\n');
}

/** Plain-text fallback for notifications and screen readers. */
export function approvalRequestText(approval: Approval): string {
  const verb = approval.action === 'pause' ? 'pause' : 'resume';
  return `Approval needed: ${verb} ${approval.campaignName}`;
}

export function approvalRequestBlocks(approval: Approval): types.KnownBlock[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `:raised_hand: *Approval needed*\n${summary(approval)}` } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: APPROVE_ACTION_ID,
          text: { type: 'plain_text', text: 'Approve' },
          style: 'primary',
          value: approval.id,
        },
        {
          type: 'button',
          action_id: CANCEL_ACTION_ID,
          text: { type: 'plain_text', text: 'Cancel' },
          value: approval.id,
        },
      ],
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'A team lead must approve within 30 minutes.' }] },
  ];
}

/** The request without its buttons, plus a line saying what happened. */
export function decidedBlocks(approval: Approval, result: string): types.KnownBlock[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: summary(approval) } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: result }] },
  ];
}

export type DecisionResponse =
  /** Replace the request message (its buttons are removed). */
  | { kind: 'update'; approval: Approval; text: string }
  /** Tell only the person who clicked. */
  | { kind: 'ephemeral'; text: string };

export function decisionResponse(outcome: DecisionOutcome, decision: Decision): DecisionResponse {
  switch (outcome.kind) {
    case 'approved': {
      const { approval } = outcome;
      const state = approval.action === 'pause' ? 'paused' : 'active again';
      return {
        kind: 'update',
        approval,
        text: `:white_check_mark: Approved by <@${approval.decidedBy}>. *${escapeMrkdwn(approval.campaignName)}* is now ${state}.`,
      };
    }
    case 'no_change': {
      const { approval } = outcome;
      const state = approval.action === 'pause' ? 'paused' : 'active';
      return {
        kind: 'update',
        approval,
        text: `:information_source: *${escapeMrkdwn(approval.campaignName)}* is already ${state}. Nothing changed.`,
      };
    }
    case 'cancelled':
      return { kind: 'update', approval: outcome.approval, text: `:x: Cancelled by <@${outcome.approval.decidedBy}>.` };
    case 'expired':
      return { kind: 'update', approval: outcome.approval, text: ':hourglass: This request has expired.' };
    case 'already_decided': {
      const { status, decidedBy } = outcome.approval;
      if (status === 'expired') return { kind: 'ephemeral', text: 'This request has expired.' };
      const verb = status === 'approved' ? 'approved' : 'cancelled';
      return { kind: 'ephemeral', text: `Already ${verb} by <@${decidedBy}>.` };
    }
    case 'not_allowed':
      return {
        kind: 'ephemeral',
        text:
          decision === 'approve'
            ? "Only team leads can approve this request. You're not on the approver list."
            : 'Only the person who asked or a team lead can cancel this request.',
      };
    case 'not_found':
      return { kind: 'ephemeral', text: "I couldn't find this request." };
  }
}
