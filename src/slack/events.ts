import type { App } from '@slack/bolt';
import type { Logger } from '../logger.js';

// Removes `<@U123>` mentions so the echo doesn't ping anyone.
export function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, '').replace(/\s+/g, ' ').trim();
}

export function registerEventHandlers(app: App, logger: Logger): void {
  // M1: echo the mention back in a thread. Replaced by the agent loop in M3.
  app.event('app_mention', async ({ event, say }) => {
    const threadTs = event.thread_ts ?? event.ts;
    logger.info({ channel: event.channel, ts: event.ts, threadTs }, 'mention received');

    const text = stripMentions(event.text);
    await say({
      text: text ? `Echo: ${text}` : 'Hi! Ask me about a campaign.',
      thread_ts: threadTs,
    });
  });
}
