import { describe, expect, it } from 'vitest';
import { stripBotMention, toSlackMrkdwn } from '../src/slack/format.js';

describe('stripBotMention', () => {
  it("removes only the bot's mention and tidies whitespace", () => {
    expect(stripBotMention('<@U0PULSE>  how did <@U012ABC> do?', 'U0PULSE')).toBe('how did <@U012ABC> do?');
  });

  it('returns an empty string for a bare mention', () => {
    expect(stripBotMention('<@U0PULSE>', 'U0PULSE')).toBe('');
  });
});

describe('toSlackMrkdwn', () => {
  it('converts Markdown bold and headings to Slack bold', () => {
    expect(toSlackMrkdwn('## Summary\n**Summer Sale** is up')).toBe('*Summary*\n*Summer Sale* is up');
  });

  it('leaves Slack formatting alone', () => {
    expect(toSlackMrkdwn('*CPL:* $18.41\n- ROAS 3.72x')).toBe('*CPL:* $18.41\n- ROAS 3.72x');
  });
});
