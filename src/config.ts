import { z } from 'zod';

const slackUserIds = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  )
  .pipe(
    z
      .array(z.string().regex(/^[UW][A-Z0-9]+$/, 'must be Slack user IDs like U012ABCDEF'))
      .min(1, 'needs at least one Slack user ID'),
  );

export const DEFAULT_DATABASE_PATH = './data/pulse.db';

/** USD per million tokens (prompts up to 100K tokens). Used to estimate spend for the daily budget. */
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

const schema = z.object({
  SLACK_BOT_TOKEN: z.string().startsWith('xoxb-', 'must be a bot token starting with xoxb-'),
  SLACK_APP_TOKEN: z.string().startsWith('xapp-', 'must be an app-level token starting with xapp-'),
  ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-', 'must be an Anthropic API key starting with sk-ant-'),
  ANTHROPIC_MODEL: z
    .string()
    .default('claude-haiku-5-5')
    .refine((model) => model in MODEL_PRICES, "has no price in MODEL_PRICES (src/config.ts), so its cost can't be estimated"),
  APPROVER_USER_IDS: slackUserIds,
  DAILY_BUDGET_USD: z.coerce.number().positive().default(1),
  DATABASE_PATH: z.string().default(DEFAULT_DATABASE_PATH),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Config = z.infer<typeof schema>;

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined>): Config {
  // `.env` lines like `ANTHROPIC_MODEL=` arrive as empty strings; treat them as unset so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(`Invalid configuration. Check your .env file:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
