import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { addDays, utcToday } from '../src/dates.js';

describe('openDatabase', () => {
  it('creates every table', () => {
    const db = openDatabase(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .pluck()
      .all();
    expect(tables).toEqual([
      'approvals',
      'audit_log',
      'campaigns',
      'conversations',
      'daily_metrics',
      'processed_events',
      'usage_log',
    ]);
  });

  it('enforces foreign keys', () => {
    const db = openDatabase(':memory:');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() =>
      db
        .prepare(
          'INSERT INTO daily_metrics (campaign_id, date, spend, impressions, clicks, leads, revenue) VALUES (999, ?, 0, 0, 0, 0, 0)',
        )
        .run('2026-06-30'),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe('dates', () => {
  it('formats today as a UTC date', () => {
    expect(utcToday(new Date('2026-06-30T23:30:00-05:00'))).toBe('2026-07-01');
  });

  it('adds and subtracts days across month and year boundaries', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-06-30', 0)).toBe('2026-06-30');
  });
});
