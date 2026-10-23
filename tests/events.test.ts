import { describe, expect, it } from 'vitest';
import { stripMentions } from '../src/slack/events.js';

describe('stripMentions', () => {
  it('removes user mentions and collapses whitespace', () => {
    expect(stripMentions('<@U0PULSE> how did   <@U012ABC> do?')).toBe('how did do?');
  });

  it('returns an empty string for a bare mention', () => {
    expect(stripMentions('<@U0PULSE>')).toBe('');
  });
});
