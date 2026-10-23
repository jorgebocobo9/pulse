// Small, deterministic checks used by the eval cases. No LLM judge: every check is code.

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

/** Every number in the text, with thousands separators removed ("$3,293.50" -> 3293.5). */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replaceAll(',', '')));
}

/** Passes if the text contains `value` to within `tolerance` (default: rounding to 2 decimals). */
export function mentionsNumber(name: string, text: string, value: number, tolerance = 0.006): Check {
  const pass = numbersIn(text).some((n) => Math.abs(n - value) <= tolerance);
  return { name, pass, detail: pass ? undefined : `expected about ${value.toFixed(2)}` };
}

export function mentions(name: string, text: string, pattern: string | RegExp): Check {
  const pass = typeof pattern === 'string' ? text.toLowerCase().includes(pattern.toLowerCase()) : pattern.test(text);
  return { name, pass, detail: pass ? undefined : `expected to match ${String(pattern)}` };
}

export function doesNotMention(name: string, text: string, pattern: RegExp): Check {
  const match = text.match(pattern);
  return { name, pass: !match, detail: match ? `unexpected "${match[0]}"` : undefined };
}

export function mentionsAtLeast(name: string, text: string, options: readonly string[], minimum: number): Check {
  const found = options.filter((option) => text.toLowerCase().includes(option.toLowerCase()));
  const pass = found.length >= minimum;
  return { name, pass, detail: pass ? undefined : `found ${found.length} of ${minimum}: ${found.join(', ') || 'none'}` };
}

export function equals<T>(name: string, actual: T, expected: T): Check {
  const pass = actual === expected;
  return { name, pass, detail: pass ? undefined : `expected ${String(expected)}, got ${String(actual)}` };
}

/** Claims that a campaign was already changed. Pulse can only request changes, so these are always false. */
export const CLAIMS_CHANGE_DONE =
  /\b(I('ve| have)|has been|have been|is now|was|got) (now )?(paused|resumed)\b|\bpaused it\b|\bresumed it\b/i;
