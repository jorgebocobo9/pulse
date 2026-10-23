import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  conversationExists,
  loadHistory,
  MAX_HISTORY_MESSAGES,
  prepareForStorage,
  saveHistory,
} from '../src/agent/history.js';
import { openDatabase } from '../src/db/client.js';

function toolTurn(n: number): Anthropic.MessageParam[] {
  return [
    { role: 'user', content: `question ${n}` },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'tool_use', id: `tool_${n}`, name: 'list_campaigns', input: {} },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool_${n}`, content: '[]' }] },
    { role: 'assistant', content: [{ type: 'text', text: `answer ${n}` }] },
  ];
}

describe('prepareForStorage', () => {
  it('removes thinking blocks but keeps text and tool calls', () => {
    const [, assistant] = prepareForStorage(toolTurn(1));
    expect(assistant!.content).toEqual([{ type: 'tool_use', id: 'tool_1', name: 'list_campaigns', input: {} }]);
  });

  it('removes redacted thinking too', () => {
    const stored = prepareForStorage([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', data: 'x' },
          { type: 'text', text: 'hello' },
        ],
      },
    ]);
    expect(stored[1]!.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('keeps short histories whole', () => {
    expect(prepareForStorage(toolTurn(1))).toHaveLength(4);
  });

  it('trims to the last 20 messages, cutting only where a user turn starts', () => {
    const history = Array.from({ length: 6 }, (_, i) => toolTurn(i + 1)).flat(); // 24 messages
    const stored = prepareForStorage(history);

    expect(stored.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES);
    expect(stored).toHaveLength(20);
    expect(stored[0]).toEqual({ role: 'user', content: 'question 2' });
  });

  it('never keeps a tool_result without the tool_use before it', () => {
    // Odd-sized turns force the cut to land away from a fixed position.
    const history = [
      ...toolTurn(1),
      { role: 'user', content: 'quick one' } as const,
      { role: 'assistant', content: 'sure' } as const,
      ...Array.from({ length: 4 }, (_, i) => toolTurn(i + 2)).flat(),
    ];
    const stored = prepareForStorage(history);
    const toolUseIds = new Set(
      stored.flatMap((m) =>
        Array.isArray(m.content) ? m.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : [])) : [],
      ),
    );
    for (const message of stored) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block.type === 'tool_result') expect(toolUseIds.has(block.tool_use_id)).toBe(true);
      }
    }
    expect(stored[0]!.role).toBe('user');
    expect(typeof stored[0]!.content).toBe('string');
  });

  it('keeps the latest turn even if it alone is longer than the limit', () => {
    const longTurn: Anthropic.MessageParam[] = [
      { role: 'user', content: 'big question' },
      ...Array.from({ length: 12 }, (_, i): Anthropic.MessageParam[] => [
        { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'list_campaigns', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: '[]' }] },
      ]).flat(),
    ];
    const stored = prepareForStorage([...toolTurn(1), ...longTurn]);
    expect(stored[0]).toEqual({ role: 'user', content: 'big question' });
  });
});

describe('saveHistory and loadHistory', () => {
  it('round-trips the stored form of a conversation', () => {
    const db = openDatabase(':memory:');
    expect(loadHistory(db, 'C1:1.0')).toEqual([]);
    expect(conversationExists(db, 'C1:1.0')).toBe(false);

    saveHistory(db, 'C1:1.0', toolTurn(1));

    expect(conversationExists(db, 'C1:1.0')).toBe(true);
    expect(loadHistory(db, 'C1:1.0')).toEqual(prepareForStorage(toolTurn(1)));

    saveHistory(db, 'C1:1.0', [...toolTurn(1), ...toolTurn(2)]);
    expect(loadHistory(db, 'C1:1.0')).toHaveLength(8);
  });
});
