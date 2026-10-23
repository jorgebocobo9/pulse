// Runs two real turns against the Claude API (no Slack) to check the agent end to end.
// Usage: npx tsx scripts/smoke.ts
import { config as loadDotenv } from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { pino } from 'pino';
import { loadHistory, saveHistory } from '../src/agent/history.js';
import { runTurn } from '../src/agent/loop.js';
import { openDatabase } from '../src/db/client.js';
import { seedDatabase } from '../src/db/seed.js';
import { utcToday } from '../src/dates.js';
import { estimateCostUsd } from '../src/services/budget.js';

loadDotenv({ quiet: true });
const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3 });
const db = openDatabase(':memory:');
const today = utcToday();
seedDatabase(db, today);
const logger = pino({ level: 'info' });
const options = { createMessage: (p: Anthropic.MessageCreateParamsNonStreaming) => anthropic.messages.create(p), db, logger, model, today };

let totalCost = 0;
for (const question of ['How did Summer Sale do over the last 7 days?', 'And how does that compare with Black Friday Leads?']) {
  const result = await runTurn(options, loadHistory(db, 'smoke'), question);
  if (result.messages) saveHistory(db, 'smoke', result.messages);
  totalCost += estimateCostUsd(model, result.inputTokens, result.outputTokens);
  console.log(`\nQ: ${question}\n[${result.outcome}, ${result.rounds} rounds, ${result.inputTokens} in / ${result.outputTokens} out]\n${result.reply}\n`);
}
console.log(`Estimated cost: $${totalCost.toFixed(5)}`);
