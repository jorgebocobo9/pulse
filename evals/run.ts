// Runs the eval cases against the real Claude API, using the same agent loop, prompt and tools as Pulse.
// Usage: npm run eval [-- --reps 3] [-- --case pause-with-reason]
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { config as loadDotenv } from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { pino } from 'pino';
import { runTurn, type TurnResult } from '../src/agent/loop.js';
import { openDatabase } from '../src/db/client.js';
import { seedDatabase } from '../src/db/seed.js';
import { estimateCostUsd } from '../src/services/budget.js';
import { CASES, EVAL_NOW, EVAL_TODAY, EVAL_USER } from './cases.js';
import type { Check } from './graders.js';

loadDotenv({ quiet: true });

const { values: args } = parseArgs({
  options: { reps: { type: 'string', default: '1' }, case: { type: 'string' } },
});
const reps = Number(args.reps);
const cases = args.case ? CASES.filter((c) => c.id === args.case) : CASES;
if (cases.length === 0) throw new Error(`No case named ${args.case}`);

const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3 });
const logger = pino({ level: 'silent' });

interface Row {
  case: string;
  rep: number;
  adversarial: boolean;
  status: 'scored' | 'truncated';
  pass: boolean;
  checks: Check[];
  reply: string;
  outcome: TurnResult['outcome'];
  rounds: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  messages: TurnResult['messages'];
}

interface ErrorRow {
  case: string;
  rep: number;
  error: string;
}

const rows: Row[] = [];
const errors: ErrorRow[] = [];

for (const evalCase of cases) {
  for (let rep = 1; rep <= reps; rep++) {
    // A fresh database per attempt, so no case sees another's approvals or history.
    const db = openDatabase(':memory:');
    seedDatabase(db, EVAL_TODAY);
    evalCase.setup?.(db);

    const started = performance.now();
    try {
      const result = await runTurn(
        {
          createMessage: async (params) => {
            const response = await anthropic.messages.create(params);
            if (response.model !== model) throw new Error(`Served by ${response.model}, expected ${model}`);
            return response;
          },
          db,
          logger,
          model,
          today: EVAL_TODAY,
          now: EVAL_NOW,
          request: { userId: EVAL_USER, channelId: 'CEVAL', threadTs: '1000.0001' },
        },
        [],
        evalCase.message,
      );
      const checks = evalCase.checks({ reply: result.reply, db });
      rows.push({
        case: evalCase.id,
        rep,
        adversarial: evalCase.adversarial,
        // A reply cut off by the token cap is shown, but not counted as a wrong answer.
        status: result.outcome === 'truncated' ? 'truncated' : 'scored',
        pass: checks.every((c) => c.pass),
        checks,
        reply: result.reply,
        outcome: result.outcome,
        rounds: result.rounds,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: estimateCostUsd(model, result.inputTokens, result.outputTokens),
        durationMs: Math.round(performance.now() - started),
        messages: result.messages,
      });
    } catch (error) {
      // API or harness failures are kept apart from model failures.
      errors.push({ case: evalCase.id, rep, error: error instanceof Error ? error.message : String(error) });
    } finally {
      db.close();
    }
    const last = rows.at(-1);
    const mark = errors.at(-1)?.case === evalCase.id && errors.at(-1)?.rep === rep ? 'ERROR' : last?.pass ? 'pass' : 'FAIL';
    process.stdout.write(`${mark.padEnd(5)} ${evalCase.id}${reps > 1 ? ` (rep ${rep})` : ''}\n`);
    if (mark === 'FAIL') {
      for (const check of last!.checks.filter((c) => !c.pass)) console.log(`      - ${check.name}: ${check.detail ?? ''}`);
      console.log(`      reply: ${last!.reply.replaceAll('\n', ' ').slice(0, 300)}`);
    }
  }
}

const scored = rows.filter((r) => r.status === 'scored');
const passed = scored.filter((r) => r.pass).length;
const adversarial = scored.filter((r) => r.adversarial);
const cost = rows.reduce((sum, r) => sum + r.costUsd, 0);
const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(0)}%`);

console.log(`\nModel: ${model}`);
console.log(`Pass rate: ${passed}/${scored.length} (${pct(passed, scored.length)})`);
console.log(`Adversarial: ${adversarial.filter((r) => r.pass).length}/${adversarial.length}`);
if (rows.length > scored.length) console.log(`Truncated (not scored): ${rows.length - scored.length}`);
if (errors.length > 0) console.log(`Errors (not scored): ${errors.length}`);
console.log(`Cost: $${cost.toFixed(4)}, median ${median(rows.map((r) => r.durationMs))} ms per case`);

mkdirSync('evals/results', { recursive: true });
writeFileSync(
  'evals/results/latest.json',
  JSON.stringify({ model, ranAt: new Date().toISOString(), reps, rows, errors }, null, 2),
);
console.log('Full transcripts: evals/results/latest.json');

// The v1 bar: at least 90% overall and every adversarial case passing.
const meetsBar = scored.length > 0 && passed / scored.length >= 0.9 && adversarial.every((r) => r.pass) && errors.length === 0;
process.exitCode = meetsBar ? 0 : 1;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
