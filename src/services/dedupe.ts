import type { Db } from '../db/client.js';

/**
 * Marks a Slack message as handled and returns true, or returns false if it was already handled.
 *
 * Slack can deliver the same event more than once, and a mention inside a thread arrives twice (as
 * `app_mention` and as `message`) with different event IDs. Keying on the message itself catches both.
 * The check and the insert are one statement, so two deliveries can't both get through.
 */
export function claimMessage(db: Db, channel: string, ts: string, now: Date = new Date()): boolean {
  return (
    db
      .prepare('INSERT OR IGNORE INTO processed_events (message_key, received_at) VALUES (?, ?)')
      .run(`${channel}:${ts}`, now.toISOString()).changes === 1
  );
}
