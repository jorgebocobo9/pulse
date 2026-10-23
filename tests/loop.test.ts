import type Anthropic from '@anthropic-ai/sdk';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BUDGET_REPLY,
  LOOP_LIMIT_REPLY,
  MAX_ROUNDS,
  REFUSAL_REPLY,
  runTurn,
  TRUNCATED_REPLY,
  type AgentOptions,
} from '../src/agent/loop.js';
import { SYSTEM_PROMPT } from '../src/agent/prompt.js';
import { openDatabase } from '../src/db/client.js';
import { seedDatabase } from '../src/db/seed.js';

const TODAY = '2026-06-30';

function response(
  content: Array<Record<string, unknown>>,
  stopReason: Anthropic.StopReason = 'end_turn',
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
  } as unknown as Anthropic.Message;
}

const text = (value: string) => ({ type: 'text', text: value, citations: null });
const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });

/** A fake client that returns the given responses in order and records every request. */
function fakeClient(responses: Anthropic.Message[] | (() => Anthropic.Message)) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const createMessage = async (params: Anthropic.MessageCreateParamsNonStreaming) => {
    // Copy, because the loop keeps appending to the same array.
    requests.push({ ...params, messages: structuredClone(params.messages) });
    const next = typeof responses === 'function' ? responses() : responses.shift();
    if (!next) throw new Error('no more fake responses');
    return next;
  };
  return { createMessage, requests };
}

let options: Omit<AgentOptions, 'createMessage'>;
beforeEach(() => {
  const db = openDatabase(':memory:');
  seedDatabase(db, TODAY);
  options = {
    db,
    logger: pino({ level: 'silent' }),
    model: 'claude-haiku-5-5',
    today: TODAY,
    now: new Date('2026-06-30T10:00:00.000Z'),
    request: { userId: 'UBUYER', channelId: 'C1', threadTs: '111.222' },
  };
});

describe('runTurn', () => {
  it('answers directly when Claude needs no tools', async () => {
    const { createMessage, requests } = fakeClient([response([text('Hello!')])]);
    const result = await runTurn({ ...options, createMessage }, [], 'hi');

    expect(result).toMatchObject({ reply: 'Hello!', outcome: 'answered', rounds: 1, inputTokens: 100, outputTokens: 20 });
    expect(result.messages).toHaveLength(2);

    const request = requests[0]!;
    expect(request).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      output_config: { effort: 'low' },
    });
    expect(request).not.toHaveProperty('temperature');
    expect(request.tools).toHaveLength(6);
    expect(request.messages[0]).toEqual({ role: 'user', content: 'Today is 2026-06-30 (UTC).\n\nhi' });
  });

  it('runs a tool and sends the result back to Claude', async () => {
    const { createMessage, requests } = fakeClient([
      response([toolUse('t1', 'get_campaign_stats', { campaign_name: 'summer sale', days: 7 })], 'tool_use'),
      response([text('Summer Sale spent $3,300.')]),
    ]);
    const result = await runTurn({ ...options, createMessage }, [], 'How did Summer Sale do?');

    expect(result).toMatchObject({ reply: 'Summer Sale spent $3,300.', outcome: 'answered', rounds: 2, inputTokens: 200 });
    const toolResults = requests[1]!.messages.at(-1)!;
    expect(toolResults.role).toBe('user');
    const [block] = toolResults.content as Anthropic.ToolResultBlockParam[];
    expect(block).toMatchObject({ type: 'tool_result', tool_use_id: 't1', is_error: false });
    expect(JSON.parse(block!.content as string)).toMatchObject({ campaign: 'Summer Sale', days: 7 });
  });

  it('runs parallel tool calls in one round and returns all results in one message', async () => {
    const { createMessage, requests } = fakeClient([
      response(
        [
          toolUse('a', 'get_campaign_stats', { campaign_name: 'Summer Sale', days: 7 }),
          toolUse('b', 'get_campaign_stats', { campaign_name: 'Retargeting Q4', days: 7 }),
        ],
        'tool_use',
      ),
      response([text('Compared.')]),
    ]);
    const result = await runTurn({ ...options, createMessage }, [], 'Compare them');

    expect(result.rounds).toBe(2);
    const results = requests[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(results.map((r) => r.tool_use_id)).toEqual(['a', 'b']);
  });

  it('returns invalid tool input to Claude as an error so it can correct itself', async () => {
    const { createMessage, requests } = fakeClient([
      response([toolUse('t1', 'get_campaign_stats', { campaign_name: 'Summer Sale', days: 400 })], 'tool_use'),
      response([text('I can only look back 90 days.')]),
    ]);
    await runTurn({ ...options, createMessage }, [], 'Last 400 days?');

    const [block] = requests[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(block).toMatchObject({ is_error: true });
    expect(block!.content).toMatch(/Invalid input/);
  });

  it('keeps thinking blocks within the turn so Claude can continue after a tool call', async () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'sig-1' };
    const { createMessage, requests } = fakeClient([
      response([thinking, toolUse('t1', 'list_campaigns', {})], 'tool_use'),
      response([text('Five campaigns.')]),
    ]);
    await runTurn({ ...options, createMessage }, [], 'List them');

    const assistant = requests[1]!.messages.at(-2)!;
    expect(assistant.content).toEqual([thinking, toolUse('t1', 'list_campaigns', {})]);
  });

  it('stops after the round limit and answers every open tool call', async () => {
    let n = 0;
    const { createMessage, requests } = fakeClient(() =>
      response([toolUse(`t${++n}`, 'list_campaigns', {})], 'tool_use'),
    );
    const result = await runTurn({ ...options, createMessage }, [], 'Loop forever');

    expect(requests).toHaveLength(MAX_ROUNDS);
    expect(result).toMatchObject({ reply: LOOP_LIMIT_REPLY, outcome: 'loop_limit', rounds: MAX_ROUNDS });

    const messages = result.messages!;
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: LOOP_LIMIT_REPLY });
    const lastResults = messages.at(-2)!.content as Anthropic.ToolResultBlockParam[];
    expect(lastResults).toEqual([
      { type: 'tool_result', tool_use_id: `t${MAX_ROUNDS}`, content: expect.stringMatching(/Step limit/), is_error: true },
    ]);

    // Every tool_use in the saved conversation has a matching tool_result.
    const used = messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : [])) : [],
    );
    const answered = messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content.flatMap((b) => (b.type === 'tool_result' ? [b.tool_use_id] : [])) : [],
    );
    expect(answered).toEqual(used);
  });

  it('does not save a refused turn', async () => {
    const { createMessage } = fakeClient([response([], 'refusal')]);
    const result = await runTurn({ ...options, createMessage }, [], 'something unsafe');
    expect(result).toMatchObject({ reply: REFUSAL_REPLY, outcome: 'refusal', messages: null });
  });

  it('explains when the answer was cut off before any text', async () => {
    const { createMessage } = fakeClient([
      response([{ type: 'thinking', thinking: '', signature: 's' }], 'max_tokens'),
    ]);
    const result = await runTurn({ ...options, createMessage }, [], 'Write an essay');
    expect(result).toMatchObject({ reply: TRUNCATED_REPLY, outcome: 'truncated' });
    expect(result.messages!.at(-1)).toEqual({ role: 'assistant', content: TRUNCATED_REPLY });
  });

  it('builds on earlier history without changing it', async () => {
    const history: Anthropic.MessageParam[] = [
      { role: 'user', content: 'Today is 2026-06-29 (UTC).\n\nfirst' },
      { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
    ];
    const snapshot = structuredClone(history);
    const { createMessage, requests } = fakeClient([response([text('second answer')])]);

    const result = await runTurn({ ...options, createMessage }, history, 'second');

    expect(history).toEqual(snapshot);
    expect(requests[0]!.messages.slice(0, 2)).toEqual(snapshot);
    expect(result.messages).toHaveLength(4);
  });

  it('reports usage after every API response', async () => {
    const usages: Anthropic.Usage[] = [];
    const { createMessage } = fakeClient([
      response([toolUse('t1', 'list_campaigns', {})], 'tool_use'),
      response([text('Done.')]),
    ]);
    await runTurn({ ...options, createMessage, onUsage: (u) => usages.push(u) }, [], 'List');
    expect(usages).toHaveLength(2);
  });

  it('returns the approval requests created during the turn', async () => {
    const { createMessage } = fakeClient([
      response(
        [toolUse('t1', 'request_pause_campaign', { campaign_name: 'Black Friday Leads', reason: 'CPL is too high' })],
        'tool_use',
      ),
      response([text('Requested. A team lead needs to approve it.')]),
    ]);
    const result = await runTurn({ ...options, createMessage }, [], 'Pause Black Friday Leads, CPL is too high');

    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0]).toMatchObject({ action: 'pause', campaignName: 'Black Friday Leads', requestedBy: 'UBUYER' });
  });
});

describe('runTurn budget guard', () => {
  it('does not call Claude when the budget is already used up', async () => {
    const { createMessage, requests } = fakeClient([response([text('never sent')])]);
    const result = await runTurn({ ...options, createMessage, isOverBudget: () => true }, [], 'hi');

    expect(requests).toHaveLength(0);
    expect(result).toMatchObject({ reply: BUDGET_REPLY, outcome: 'over_budget', messages: null, rounds: 0 });
  });

  it('stops mid-turn when the budget runs out, leaving a valid history', async () => {
    let calls = 0;
    const { createMessage, requests } = fakeClient([
      response([toolUse('t1', 'list_campaigns', {})], 'tool_use'),
      response([text('never sent')]),
    ]);
    const result = await runTurn({ ...options, createMessage, isOverBudget: () => ++calls > 1 }, [], 'List');

    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ reply: BUDGET_REPLY, outcome: 'over_budget', rounds: 1 });
    const messages = result.messages!;
    expect(messages.at(-2)!.content).toEqual([expect.objectContaining({ type: 'tool_result', tool_use_id: 't1' })]);
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: BUDGET_REPLY });
  });
});
