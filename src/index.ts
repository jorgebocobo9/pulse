import { config as loadDotenv } from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { App, LogLevel } from '@slack/bolt';
import { ConfigError, loadConfig, type Config } from './config.js';
import { openDatabase } from './db/client.js';
import { listCampaigns } from './db/queries.js';
import { createLogger } from './logger.js';
import { registerActionHandlers } from './slack/actions.js';
import { registerEventHandlers } from './slack/events.js';

loadDotenv({ quiet: true });

let config: Config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const logger = createLogger(config.LOG_LEVEL);
const db = openDatabase(config.DATABASE_PATH);
if (listCampaigns(db).length === 0) {
  logger.warn('The database has no campaigns yet. Run `npm run seed` to load the demo data.');
}

// The SDK retries 408, 409, 429 and 5xx responses with exponential backoff.
const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 3 });

const app = new App({
  token: config.SLACK_BOT_TOKEN,
  appToken: config.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.WARN,
});

registerEventHandlers(app, {
  db,
  logger,
  model: config.ANTHROPIC_MODEL,
  createMessage: (params) => anthropic.messages.create(params),
  dailyBudgetUsd: config.DAILY_BUDGET_USD,
});
registerActionHandlers(app, { db, logger, approverIds: config.APPROVER_USER_IDS });

app.error(async (error) => {
  logger.error({ err: error }, 'unhandled Slack error');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    logger.info({ signal }, 'shutting down');
    await app.stop();
    db.close();
    process.exit(0);
  });
}

await app.start();
logger.info({ model: config.ANTHROPIC_MODEL }, 'Pulse is running in Socket Mode');
