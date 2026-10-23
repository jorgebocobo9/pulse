import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const validEnv = {
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_APP_TOKEN: 'xapp-test',
  APPROVER_USER_IDS: 'U012ABCDEF, U034GHIJKL',
};

describe('loadConfig', () => {
  it('applies defaults for optional values', () => {
    const config = loadConfig(validEnv);
    expect(config.ANTHROPIC_MODEL).toBe('claude-haiku-5-5');
    expect(config.DAILY_BUDGET_USD).toBe(1);
    expect(config.DATABASE_PATH).toBe('./data/pulse.db');
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('splits and trims approver IDs', () => {
    expect(loadConfig(validEnv).APPROVER_USER_IDS).toEqual(['U012ABCDEF', 'U034GHIJKL']);
  });

  it('treats empty values as unset so defaults still apply', () => {
    const config = loadConfig({ ...validEnv, ANTHROPIC_MODEL: '', DAILY_BUDGET_USD: '' });
    expect(config.ANTHROPIC_MODEL).toBe('claude-haiku-5-5');
    expect(config.DAILY_BUDGET_USD).toBe(1);
  });

  it('parses the daily budget as a number', () => {
    expect(loadConfig({ ...validEnv, DAILY_BUDGET_USD: '2.5' }).DAILY_BUDGET_USD).toBe(2.5);
  });

  it('fails with a clear message when APPROVER_USER_IDS is empty', () => {
    expect(() => loadConfig({ ...validEnv, APPROVER_USER_IDS: '' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv, APPROVER_USER_IDS: ' , ' })).toThrow(/at least one Slack user ID/);
  });

  it('rejects approver values that are not Slack user IDs', () => {
    expect(() => loadConfig({ ...validEnv, APPROVER_USER_IDS: '@jorge' })).toThrow(/Slack user IDs/);
  });

  it('rejects tokens of the wrong type', () => {
    expect(() => loadConfig({ ...validEnv, SLACK_BOT_TOKEN: 'xapp-oops' })).toThrow(/xoxb-/);
    expect(() => loadConfig({ ...validEnv, SLACK_APP_TOKEN: 'xoxb-oops' })).toThrow(/xapp-/);
  });

  it('rejects a non-positive budget', () => {
    expect(() => loadConfig({ ...validEnv, DAILY_BUDGET_USD: '0' })).toThrow(ConfigError);
  });
});
