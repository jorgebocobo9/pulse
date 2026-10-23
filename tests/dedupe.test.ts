import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { claimMessage } from '../src/services/dedupe.js';

describe('claimMessage', () => {
  it('lets each message through once', () => {
    const db = openDatabase(':memory:');
    expect(claimMessage(db, 'C1', '111.222')).toBe(true);
    // A retry, or the same mention arriving as both app_mention and message.
    expect(claimMessage(db, 'C1', '111.222')).toBe(false);
  });

  it('treats the same timestamp in different channels as different messages', () => {
    const db = openDatabase(':memory:');
    expect(claimMessage(db, 'C1', '111.222')).toBe(true);
    expect(claimMessage(db, 'C2', '111.222')).toBe(true);
    expect(claimMessage(db, 'C1', '111.223')).toBe(true);
  });
});
