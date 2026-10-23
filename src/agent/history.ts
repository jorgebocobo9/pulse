import type Anthropic from '@anthropic-ai/sdk';
import type { Db } from '../db/client.js';

export const MAX_HISTORY_MESSAGES = 20;

export function conversationExists(db: Db, key: string): boolean {
  return db.prepare('SELECT 1 FROM conversations WHERE thread_key = ?').get(key) !== undefined;
}

export function loadHistory(db: Db, key: string): Anthropic.MessageParam[] {
  const json = db.prepare<[string], string>('SELECT messages FROM conversations WHERE thread_key = ?').pluck().get(key);
  return json ? (JSON.parse(json) as Anthropic.MessageParam[]) : [];
}

export function saveHistory(db: Db, key: string, messages: Anthropic.MessageParam[], now: Date = new Date()): void {
  db.prepare(
    `INSERT INTO conversations (thread_key, messages, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (thread_key) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(prepareForStorage(messages)), now.toISOString());
}

/**
 * Removes thinking blocks, then keeps at most the last MAX_HISTORY_MESSAGES messages, cutting only where
 * a user turn starts.
 *
 * Thinking blocks are only valid while everything before them is unchanged, and trimming changes that, so
 * stored history keeps the answers and tool calls but not the reasoning. Cutting at a turn start means a
 * tool_result is never kept without its tool_use, and the history always begins with a plain user message.
 */
export function prepareForStorage(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const stripped = messages.map((message) =>
    message.role === 'assistant' && Array.isArray(message.content)
      ? {
          ...message,
          content: message.content.filter((block) => block.type !== 'thinking' && block.type !== 'redacted_thinking'),
        }
      : message,
  );

  const turnStarts = stripped.flatMap((message, index) => (isTurnStart(message) ? [index] : []));
  const keepFrom = turnStarts.find((index) => stripped.length - index <= MAX_HISTORY_MESSAGES) ?? turnStarts.at(-1) ?? 0;
  return stripped.slice(keepFrom);
}

// The user's own messages are stored as plain strings; tool results are arrays of tool_result blocks.
function isTurnStart(message: Anthropic.MessageParam): boolean {
  return message.role === 'user' && typeof message.content === 'string';
}
