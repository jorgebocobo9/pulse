import { describe, expect, it } from 'vitest';
import type { Approval } from '../src/services/approvals.js';
import {
  APPROVE_ACTION_ID,
  approvalRequestBlocks,
  CANCEL_ACTION_ID,
  decisionResponse,
  escapeMrkdwn,
} from '../src/slack/blocks.js';

const approval: Approval = {
  id: 'appr-1',
  action: 'pause',
  campaignId: 2,
  campaignName: 'Black Friday Leads',
  reason: 'CPL is too high',
  requestedBy: 'UBUYER',
  status: 'pending',
  decidedBy: null,
  createdAt: '2026-06-30T10:00:00.000Z',
  expiresAt: '2026-06-30T10:30:00.000Z',
  decidedAt: null,
  channelId: 'C1',
  threadTs: '111.222',
  messageTs: '333.444',
};

describe('escapeMrkdwn', () => {
  it('neutralises mentions, links and broadcast pings', () => {
    expect(escapeMrkdwn('<!channel> see <https://x.io|this> & <@U1>')).toBe(
      '&lt;!channel&gt; see &lt;https://x.io|this&gt; &amp; &lt;@U1&gt;',
    );
  });
});

describe('approvalRequestBlocks', () => {
  it('shows the request with Approve and Cancel buttons carrying the approval id', () => {
    const blocks = approvalRequestBlocks({ ...approval, reason: 'ping <!here>' });
    const text = JSON.stringify(blocks);
    expect(text).toContain('Pause Black Friday Leads');
    expect(text).toContain('<@UBUYER>');
    expect(text).toContain('ping &lt;!here&gt;');
    expect(text).not.toContain('<!here>');

    const actions = blocks.find((b) => b.type === 'actions');
    expect(actions).toMatchObject({
      elements: [
        { action_id: APPROVE_ACTION_ID, value: 'appr-1', style: 'primary' },
        { action_id: CANCEL_ACTION_ID, value: 'appr-1' },
      ],
    });
  });
});

describe('decisionResponse', () => {
  it('updates the message when a decision is made', () => {
    expect(decisionResponse({ kind: 'approved', approval: { ...approval, status: 'approved', decidedBy: 'ULEAD' } }, 'approve')).toMatchObject({
      kind: 'update',
      text: ':white_check_mark: Approved by <@ULEAD>. *Black Friday Leads* is now paused.',
    });
    expect(decisionResponse({ kind: 'cancelled', approval: { ...approval, decidedBy: 'UBUYER' } }, 'cancel')).toMatchObject({
      kind: 'update',
      text: ':x: Cancelled by <@UBUYER>.',
    });
    expect(decisionResponse({ kind: 'expired', approval }, 'approve')).toMatchObject({ kind: 'update' });
    expect(decisionResponse({ kind: 'no_change', approval }, 'approve')).toMatchObject({
      kind: 'update',
      text: ':information_source: *Black Friday Leads* is already paused. Nothing changed.',
    });
  });

  it('answers privately for a second click or a click that is not allowed', () => {
    expect(
      decisionResponse({ kind: 'already_decided', approval: { ...approval, status: 'approved', decidedBy: 'ULEAD' } }, 'approve'),
    ).toEqual({ kind: 'ephemeral', text: 'Already approved by <@ULEAD>.' });
    expect(decisionResponse({ kind: 'already_decided', approval: { ...approval, status: 'expired' } }, 'approve')).toEqual({
      kind: 'ephemeral',
      text: 'This request has expired.',
    });
    expect(decisionResponse({ kind: 'not_allowed', decision: 'approve', approval }, 'approve')).toMatchObject({
      kind: 'ephemeral',
      text: expect.stringMatching(/Only team leads/),
    });
    expect(decisionResponse({ kind: 'not_allowed', decision: 'cancel', approval }, 'cancel')).toMatchObject({
      kind: 'ephemeral',
      text: expect.stringMatching(/person who asked/),
    });
  });
});
