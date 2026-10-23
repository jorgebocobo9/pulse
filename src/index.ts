import { config as loadDotenv } from 'dotenv';
import { App, LogLevel } from '@slack/bolt';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createLogger } from './logger.js';
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

const app = new App({
  token: config.SLACK_BOT_TOKEN,
  appToken: config.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.WARN,
});

registerEventHandlers(app, logger);

app.error(async (error) => {
  logger.error({ err: error }, 'unhandled Slack error');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    logger.info({ signal }, 'shutting down');
    await app.stop();
    process.exit(0);
  });
}

await app.start();
logger.info({ model: config.ANTHROPIC_MODEL }, 'Pulse is running in Socket Mode');
