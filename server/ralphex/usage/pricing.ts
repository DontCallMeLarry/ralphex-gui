/**
 * What the tokens cost, at Anthropic's published API prices.
 *
 * The transcripts Terrarium reads carry tokens and a model name, never a
 * price — the `result` event that knows the real cost is the one ralphex
 * throws away. So the price is worked out here, from a rate table, and that
 * makes two things true that the page has to say out loud:
 *
 *   - It is an estimate at list prices. A subscription is not billed per
 *     token, and an org with negotiated rates does not pay these.
 *   - The table goes stale. Every rate is dated, and a model that is not in
 *     it costs nothing here rather than costing a guess — `unpriced` carries
 *     those tokens out so the page can admit the gap instead of hiding it.
 *
 * Prices are US dollars per million tokens, from
 * https://claude.com/pricing#api — checked on the date below.
 */
import { totalOf, type Tokens, type UsageSample } from './model.ts';

export const RATES_AS_OF = '2026-06-24';
export const PRICING_URL = 'https://claude.com/pricing#api';

// Cache tokens are priced off the input rate: a five-minute write costs a
// quarter more than fresh input, and a read costs a tenth of it.
const CACHE_WRITE = 1.25;
const CACHE_READ = 0.1;

const MILLION = 1e6;

export interface Rates {
  label: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

interface RateEntry {
  match: RegExp;
  label: string;
  input: number;
  output: number;
  /** The date an introductory rate reverts, and what it was before then. */
  until?: string;
  before?: { input: number; output: number };
}

/**
 * Longest-prefix-wins, so `claude-opus-4-6` cannot be caught by an `opus`
 * alias. A dated snapshot (`claude-haiku-4-5-20251001`) matches the family it
 * was cut from; a bare alias matches whatever that alias resolves to today.
 */
const RATES: RateEntry[] = [
  { match: /^claude-(fable|mythos)-5\b/, label: 'Fable 5', input: 10, output: 50 },
  { match: /^claude-opus-(5|4-8|4-7|4-6)\b/, label: 'Opus', input: 5, output: 25 },
  {
    match: /^claude-sonnet-5\b/,
    label: 'Sonnet 5',
    input: 3,
    output: 15,
    // Introductory pricing, and the date it reverts.
    until: '2026-08-31',
    before: { input: 2, output: 10 },
  },
  { match: /^claude-sonnet-4-6\b/, label: 'Sonnet 4.6', input: 3, output: 15 },
  { match: /^claude-haiku-4-5\b/, label: 'Haiku 4.5', input: 1, output: 5 },
  // Aliases, as ralphex passes them through: whatever the alias means today.
  { match: /^opus$/, label: 'Opus', input: 5, output: 25 },
  { match: /^sonnet$/, label: 'Sonnet 5', input: 3, output: 15, until: '2026-08-31', before: { input: 2, output: 10 } },
  { match: /^haiku$/, label: 'Haiku 4.5', input: 1, output: 5 },
];

/** The rate card for a model at a moment, or null when nothing covers it. */
export function ratesFor(model: string | null, at: number = Date.now()): Rates | null {
  const name = String(model || '').trim().toLowerCase();
  if (!name) return null;
  const entry = RATES.find((rate) => rate.match.test(name));
  if (!entry) return null;

  let { input, output } = entry;
  if (entry.until && entry.before && at <= Date.parse(`${entry.until}T23:59:59Z`)) {
    input = entry.before.input;
    output = entry.before.output;
  }
  return {
    label: entry.label,
    input,
    output,
    cacheWrite: input * CACHE_WRITE,
    cacheRead: input * CACHE_READ,
  };
}

/** Dollars for one turn's tokens at a given rate card. */
export function costOf(tokens: Partial<Tokens> = {}, rates: Rates | null): number {
  if (!rates) return 0;
  const at = (n: unknown) => (Number(n) > 0 ? Number(n) : 0);
  return (
    (at(tokens.input) * rates.input +
      at(tokens.output) * rates.output +
      at(tokens.cacheCreate) * rates.cacheWrite +
      at(tokens.cacheRead) * rates.cacheRead) /
    MILLION
  );
}

/**
 * Price a set of samples.
 *
 * @returns dollars, and the tokens no rate in the table covered — never folded
 *   into the cost as a zero
 */
export function priceSamples(samples: UsageSample[] = []): { cost: number; unpriced: number } {
  let cost = 0;
  let unpriced = 0;
  for (const sample of samples) {
    const rates = ratesFor(sample.model, sample.ts);
    if (!rates) {
      unpriced += totalOf(sample.tokens);
      continue;
    }
    cost += costOf(sample.tokens, rates);
  }
  // Sub-cent arithmetic over thousands of turns accumulates float noise;
  // nothing is billed off this number, and six decimals is a hundredth of a
  // cent.
  return { cost: Math.round(cost * 1e6) / 1e6, unpriced };
}

/** The names of models that carried tokens no rate covered. */
export function unpricedModels(samples: UsageSample[] = []): string[] {
  const names = new Set<string>();
  for (const sample of samples) {
    if (!ratesFor(sample.model, sample.ts)) names.add(sample.model || 'unknown');
  }
  return [...names];
}
