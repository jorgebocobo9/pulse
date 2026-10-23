import type { App, BlockAction, ButtonAction } from '@slack/bolt';
import type { Db } from '../db/client.js';
import type { Logger } from '../logger.js';
import { decideApproval, type Decision } from '../services/approvals.js';
import { APPROVE_ACTION_ID, CANCEL_ACTION_ID, decidedBlocks, decisionResponse } from './blocks.js';

export interface ActionDeps {
  db: Db;
  logger: Logger;
  approverIds: readonly string[];
}

export function registerActionHandlers(app: App, deps: ActionDeps): void {
  const buttons: Array<[string, Decision]> = [
    [APPROVE_ACTION_ID, 'approve'],
    [CANCEL_ACTION_ID, 'cancel'],
  ];

  for (const [actionId, decision] of buttons) {
    app.action<BlockAction<ButtonAction>>(actionId, async ({ ack, body, action, client }) => {
      // Slack needs an acknowledgment within 3 seconds, so this comes before any other work.
      await ack();

      const userId = body.user.id;
      const approvalId = action.value ?? '';
      try {
        const outcome = decideApproval(deps.db, {
          approvalId,
          decision,
          userId,
          approverIds: deps.approverIds,
          now: new Date(),
        });
        deps.logger.info({ approvalId, decision, userId, outcome: outcome.kind }, 'approval button clicked');

        const response = decisionResponse(outcome, decision);
        if (response.kind === 'update') {
          const { approval } = response;
          await client.chat.update({
            channel: approval.channelId,
            ts: approval.messageTs ?? body.message?.ts ?? '',
            text: response.text,
            blocks: decidedBlocks(approval, response.text),
          });
        } else if (body.channel) {
          await client.chat.postEphemeral({
            channel: body.channel.id,
            user: userId,
            thread_ts: body.message?.thread_ts,
            text: response.text,
          });
        }
      } catch (error) {
        deps.logger.error({ err: error, approvalId, decision, userId }, 'approval button failed');
      }
    });
  }
}
