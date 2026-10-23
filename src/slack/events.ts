import Anthropic from '@anthropic-ai/sdk';
import type { App, webApi } from '@slack/bolt';
import { conversationExists, loadHistory, saveHistory } from '../agent/history.js';
import { runTurn, type CreateMessage } from '../agent/loop.js';
import type { Db } from '../db/client.js';
import { utcToday } from '../dates.js';
import type { Logger } from '../logger.js';
import { setApprovalMessageTs } from '../services/approvals.js';
import { estimateCostUsd, isOverBudget, recordUsage } from '../services/budget.js';
import { claimMessage } from '../services/dedupe.js';
import { approvalRequestBlocks, approvalRequestText } from './blocks.js';
import { stripBotMention, toSlackMrkdwn } from './format.js';

export interface EventDeps {
  db: Db;
  logger: Logger;
  model: string;
  createMessage: CreateMessage;
  dailyBudgetUsd: number;
}

interface IncomingMessage {
  channel: string;
  /** The Slack user who sent the message. Approval requests are recorded under this ID. */
  user: string;
  /** The user's message. The 👀 reaction goes on it. */
  ts: string;
  /** The thread to answer in. Undefined in DMs, where Pulse answers in the conversation itself. */
  threadTs: string | undefined;
  text: string;
}

const API_TROUBLE_REPLY = "I'm having trouble right now, please try again in a minute.";
const UNEXPECTED_ERROR_REPLY = 'Something went wrong on my side. Please try again.';
const GREETING_REPLY = 'Hi! Ask me about a campaign, for example "How did Summer Sale do this week?"';

export function registerEventHandlers(app: App, deps: EventDeps): void {
  app.event('app_mention', async ({ event, client, context }) => {
    if (!event.user) return;
    await respond(client, deps, {
      channel: event.channel,
      user: event.user,
      ts: event.ts,
      threadTs: event.thread_ts ?? event.ts,
      text: stripBotMention(event.text, context.botUserId),
    });
  });

  app.event('message', async ({ event, client, context }) => {
    // Edits, deletions, joins and bot posts all carry a subtype; only plain user messages get answers.
    if (event.subtype !== undefined || event.bot_id) return;
    const text = event.text ?? '';
    // Messages that mention Pulse also arrive as app_mention, which answers them.
    if (context.botUserId && text.includes(`<@${context.botUserId}>`)) return;

    const base = { channel: event.channel, user: event.user, ts: event.ts, text };
    if (event.channel_type === 'im') {
      await respond(client, deps, { ...base, threadTs: undefined });
    } else if (
      event.channel_type === 'channel' &&
      event.thread_ts &&
      conversationExists(deps.db, conversationKey(event.channel, event.thread_ts))
    ) {
      // A reply in a thread Pulse is already part of: no mention needed.
      await respond(client, deps, { ...base, threadTs: event.thread_ts });
    }
  });
}

function conversationKey(channel: string, threadTs: string | undefined): string {
  return threadTs ? `${channel}:${threadTs}` : channel;
}

async function respond(client: webApi.WebClient, deps: EventDeps, message: IncomingMessage): Promise<void> {
  const { db, logger, model, createMessage } = deps;
  const { channel, ts, threadTs } = message;
  const key = conversationKey(channel, threadTs);
  const reply = (text: string) => client.chat.postMessage({ channel, thread_ts: threadTs, text });

  if (!claimMessage(db, channel, ts)) {
    logger.info({ key, ts }, 'duplicate message skipped');
    return;
  }

  if (!message.text) {
    await reply(GREETING_REPLY);
    return;
  }

  const started = performance.now();
  logger.debug({ key, text: message.text }, 'message received');
  await client.reactions
    .add({ channel, timestamp: ts, name: 'eyes' })
    .catch((err: unknown) => logger.warn({ err, key }, 'could not add reaction'));

  try {
    const today = utcToday();
    const result = await runTurn(
      {
        createMessage,
        db,
        logger,
        model,
        today,
        request: { userId: message.user, channelId: channel, threadTs },
        isOverBudget: () => isOverBudget(db, today, deps.dailyBudgetUsd),
        onUsage: (usage) =>
          recordUsage(db, { date: today, model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }),
      },
      loadHistory(db, key),
      message.text,
    );

    await reply(toSlackMrkdwn(result.reply));
    if (result.messages) saveHistory(db, key, result.messages);

    // Each request gets its own message with Approve and Cancel buttons, below Claude's reply.
    for (const approval of result.approvals) {
      const posted = await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: approvalRequestText(approval),
        blocks: approvalRequestBlocks(approval),
      });
      if (posted.ts) setApprovalMessageTs(db, approval.id, posted.ts);
      logger.info({ key, approvalId: approval.id, action: approval.action, campaign: approval.campaignName }, 'approval requested');
    }

    logger.info(
      {
        key,
        outcome: result.outcome,
        rounds: result.rounds,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        estCostUsd: Number(estimateCostUsd(model, result.inputTokens, result.outputTokens).toFixed(6)),
        durationMs: Math.round(performance.now() - started),
      },
      'turn finished',
    );
  } catch (error) {
    logger.error({ err: error, key }, 'turn failed');
    await reply(error instanceof Anthropic.APIError ? API_TROUBLE_REPLY : UNEXPECTED_ERROR_REPLY).catch(
      (err: unknown) => logger.error({ err, key }, 'could not post error reply'),
    );
  } finally {
    await client.reactions
      .remove({ channel, timestamp: ts, name: 'eyes' })
      .catch((err: unknown) => logger.warn({ err, key }, 'could not remove reaction'));
  }
}
