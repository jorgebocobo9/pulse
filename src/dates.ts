// All dates in Pulse are UTC calendar days in YYYY-MM-DD form.

const DAY_MS = 86_400_000;

export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}
