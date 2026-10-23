import Anthropic from '@anthropic-ai/sdk';
import type { App, webApi } from '@slack/bolt';
import { conversationExists, loadHistory, saveHistory } from '../agent/history.js';
import { runTurn, type CreateMessage } from '../agent/loop.js';
import type { Db } from '../db/client.js';
import { utcToday } from '../dates.js';
import type { Logger } from '../logger.js';
import { estimateCostUsd, recordUsage } from '../services/budget.js';
import { stripBotMention, toSlackMrkdwn } from './format.js';

export interface EventDeps {
  db: Db;
  logger: Logger;
  model: string;
  createMessage: CreateMessage;
}

interface IncomingMessage {
  channel: string;
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
    await respond(client, deps, {
      channel: event.channel,
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

    if (event.channel_type === 'im') {
      await respond(client, deps, { channel: event.channel, ts: event.ts, threadTs: undefined, text });
    } else if (
      event.channel_type === 'channel' &&
      event.thread_ts &&
      conversationExists(deps.db, conversationKey(event.channel, event.thread_ts))
    ) {
      // A reply in a thread Pulse is already part of: no mention needed.
      await respond(client, deps, { channel: event.channel, ts: event.ts, threadTs: event.thread_ts, text });
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
        onUsage: (usage) =>
          recordUsage(db, { date: today, model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }),
      },
      loadHistory(db, key),
      message.text,
    );

    await reply(toSlackMrkdwn(result.reply));
    if (result.messages) saveHistory(db, key, result.messages);

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
