import { pino, type Logger } from 'pino';
import type { Config } from './config.js';

export type { Logger };

export function createLogger(level: Config['LOG_LEVEL']): Logger {
  return pino({
    level,
    // Never let a token reach the logs, even if a whole config or client object is logged by mistake.
    redact: ['*.SLACK_BOT_TOKEN', '*.SLACK_APP_TOKEN', '*.ANTHROPIC_API_KEY', '*.token', '*.appToken'],
  });
}
