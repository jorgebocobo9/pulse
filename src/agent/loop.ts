import type Anthropic from '@anthropic-ai/sdk';
import type { Db } from '../db/client.js';
import type { Logger } from '../logger.js';
import { formatUserMessage, SYSTEM_PROMPT } from './prompt.js';
import { runTool, TOOL_DEFINITIONS } from './tools.js';

export const MAX_ROUNDS = 6;
export const MAX_TOKENS = 1024;

export const REFUSAL_REPLY = "Sorry, I can't help with that request.";
export const TRUNCATED_REPLY = "Sorry, my answer got cut off. Could you ask a narrower question?";
export const LOOP_LIMIT_REPLY =
  "Sorry, I couldn't finish that within my step limit. Could you break it into smaller questions?";

export type CreateMessage = (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;

export interface AgentOptions {
  createMessage: CreateMessage;
  db: Db;
  logger: Logger;
  model: string;
  /** Today's date (UTC, YYYY-MM-DD). Tools count "the last N days" back from it. */
  today: string;
  maxRounds?: number;
  /** Called after every API response, so usage is recorded even if a later call fails. */
  onUsage?: (usage: Anthropic.Usage) => void;
}

export interface TurnResult {
  reply: string;
  /** The whole conversation including this turn, or null when the turn shouldn't be saved. */
  messages: Anthropic.MessageParam[] | null;
  outcome: 'answered' | 'truncated' | 'loop_limit' | 'refusal';
  rounds: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Runs one user turn: calls Claude, runs any tools it asks for, and repeats until Claude answers in text
 * or the round limit is reached. `history` is never modified; new messages are only ever appended.
 */
export async function runTurn(
  options: AgentOptions,
  history: Anthropic.MessageParam[],
  userText: string,
): Promise<TurnResult> {
  const { createMessage, db, logger, model, today, maxRounds = MAX_ROUNDS } = options;
  const messages: Anthropic.MessageParam[] = [...history, { role: 'user', content: formatUserMessage(userText, today) }];
  let inputTokens = 0;
  let outputTokens = 0;

  for (let round = 1; ; round++) {
    const response = await createMessage({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: TOOL_DEFINITIONS,
      // Thinking stays on (adaptive), but low effort keeps it from using up the token cap.
      output_config: { effort: 'low' },
      messages,
    });
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;
    options.onUsage?.(response.usage);
    const done = (reply: string, outcome: TurnResult['outcome'], saved: Anthropic.MessageParam[] | null) => ({
      reply,
      messages: saved,
      outcome,
      rounds: round,
      inputTokens,
      outputTokens,
    });

    // A refusal can stop mid tool call, so nothing from this turn is run or saved.
    if (response.stop_reason === 'refusal') return done(REFUSAL_REPLY, 'refusal', null);

    const toolUses = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
    if (toolUses.length === 0) {
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
      if (text) {
        messages.push({ role: 'assistant', content: response.content });
        return done(text, 'answered', messages);
      }
      // No text usually means the token cap was hit while thinking.
      messages.push({ role: 'assistant', content: TRUNCATED_REPLY });
      return done(TRUNCATED_REPLY, 'truncated', messages);
    }

    messages.push({ role: 'assistant', content: response.content });
    const lastRound = round >= maxRounds;
    // Every tool_use gets a tool_result, even when it isn't run, so the history stays valid.
    const results: Anthropic.ToolResultBlockParam[] = toolUses.map((toolUse) => {
      if (lastRound) return errorResult(toolUse.id, 'Step limit reached, so this tool was not run.');
      if (response.stop_reason === 'max_tokens') {
        return errorResult(toolUse.id, 'The tool input was cut off before it was complete, so this tool was not run.');
      }

      const started = performance.now();
      const outcome = runTool(toolUse.name, toolUse.input, { db, today });
      const durationMs = Math.round(performance.now() - started);
      logger.info({ tool: toolUse.name, input: toolUse.input, durationMs, isError: outcome.isError }, 'tool call');
      if (outcome.failure) logger.error({ err: outcome.failure, tool: toolUse.name }, 'tool threw an unexpected error');
      return { type: 'tool_result', tool_use_id: toolUse.id, content: outcome.content, is_error: outcome.isError };
    });
    messages.push({ role: 'user', content: results });

    if (lastRound) {
      messages.push({ role: 'assistant', content: LOOP_LIMIT_REPLY });
      return done(LOOP_LIMIT_REPLY, 'loop_limit', messages);
    }
  }
}

function errorResult(toolUseId: string, content: string): Anthropic.ToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: toolUseId, content, is_error: true };
}
