/**
 * The shape token usage takes once it is inside Terrarium.
 *
 * Nothing in this file knows where usage came from. A source adapter reads
 * whatever its agent already writes to disk and hands back UsageSamples; the
 * rest of Terrarium only ever sees this shape. That is the whole point of
 * having a standard here: adding another agent later should mean writing one
 * adapter, not touching the meter, the routes or the page.
 *
 * The four kinds are the ones every current Anthropic-shaped usage payload
 * reports, and they are disjoint, so they sum to `total`. `reasoning` is not:
 * it is the thinking slice of `output`, so adding it would count those tokens
 * twice. It travels alongside as a detail, never in the sum.
 */

export const TOKEN_KINDS = ['input', 'output', 'cacheCreate', 'cacheRead'] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

/** Human labels, so the routes and the page do not each invent their own. */
export const TOKEN_LABELS: Record<string, string> = {
  input: 'input',
  output: 'output',
  cacheCreate: 'cache write',
  cacheRead: 'cache read',
  reasoning: 'thinking',
};

export interface Tokens {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  reasoning: number;
}

export interface Totals extends Tokens {
  total: number;
  samples: number;
  firstAt: number | null;
  lastAt: number | null;
}

/** One metered model turn. */
export interface UsageSample {
  source: string;
  /** Stable identity, for de-duplication across polls. */
  key: string;
  /** ms epoch, the turn's own timestamp. */
  ts: number;
  model: string | null;
  sessionId: string | null;
  agent: 'main' | 'subagent';
  tokens: Tokens;
}

export function emptyTokens(): Tokens {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, reasoning: 0 };
}

function int(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Coerce anything source-shaped into the buckets, dropping nonsense. */
export function toTokens(input: Partial<Record<keyof Tokens, unknown>> = {}): Tokens {
  return {
    input: int(input.input),
    output: int(input.output),
    cacheCreate: int(input.cacheCreate),
    cacheRead: int(input.cacheRead),
    reasoning: int(input.reasoning),
  };
}

export function addTokens<T extends Tokens>(into: T, more: Partial<Tokens>): T {
  for (const kind of TOKEN_KINDS) into[kind] += int(more[kind]);
  into.reasoning += int(more.reasoning);
  return into;
}

/** Every token the API metered for this work. Excludes `reasoning` by design. */
export function totalOf(tokens: Partial<Tokens>): number {
  let sum = 0;
  for (const kind of TOKEN_KINDS) sum += int(tokens[kind]);
  return sum;
}

export function emptyTotals(): Totals {
  return { ...emptyTokens(), total: 0, samples: 0, firstAt: null, lastAt: null };
}

/** Fold samples into one totals record. */
export function totalsFor(samples: UsageSample[] = []): Totals {
  const totals = emptyTotals();
  for (const sample of samples) {
    addTokens(totals, sample.tokens);
    totals.samples += 1;
    if (totals.firstAt === null || sample.ts < totals.firstAt) totals.firstAt = sample.ts;
    if (totals.lastAt === null || sample.ts > totals.lastAt) totals.lastAt = sample.ts;
  }
  totals.total = totalOf(totals);
  return totals;
}

/**
 * Group samples by a key and total each group, heaviest first.
 *
 * `extra` is merged into each group's record, for anything this file has no
 * business knowing — a price, say.
 */
export function groupTotals(
  samples: UsageSample[],
  keyOf: (sample: UsageSample) => string | null | undefined,
  extra: ((group: UsageSample[]) => Record<string, unknown>) | null = null,
): Array<Totals & { key: string }> {
  const groups = new Map<string, UsageSample[]>();
  for (const sample of samples) {
    const key = keyOf(sample);
    if (key === null || key === undefined) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(sample);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, ...totalsFor(group), ...(extra ? extra(group) : null) }))
    .sort((a, b) => b.total - a.total);
}
