import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { costOf, priceSamples, ratesFor, unpricedModels } from '../server/ralphex/usage/pricing.ts';
import { toTokens, type UsageSample } from '../server/ralphex/usage/model.ts';

const AFTER_INTRO = Date.parse('2026-09-01T00:00:00Z');
const DURING_INTRO = Date.parse('2026-07-01T00:00:00Z');

function sample(model: string | null, tokens: Record<string, number>, ts = AFTER_INTRO): UsageSample {
  return {
    source: 'test',
    key: `${model}-${ts}-${JSON.stringify(tokens)}`,
    ts,
    model,
    sessionId: null,
    agent: 'main',
    tokens: toTokens(tokens),
  };
}

test('a dated snapshot is priced as the family it was cut from', () => {
  assert.equal(ratesFor('claude-haiku-4-5-20251001')?.label, 'Haiku 4.5');
  assert.equal(ratesFor('claude-haiku-4-5')?.input, 1);
});

test('a bare alias is priced as whatever it resolves to today', () => {
  assert.equal(ratesFor('haiku')?.label, 'Haiku 4.5');
  assert.equal(ratesFor('opus')?.output, 25);
});

test('an alias cannot swallow a longer model name', () => {
  assert.equal(ratesFor('claude-opus-5')?.label, 'Opus');
  assert.equal(ratesFor('opus-something-else'), null);
});

test('an introductory rate reverts on its date, and turns before it keep it', () => {
  assert.equal(ratesFor('claude-sonnet-5', DURING_INTRO)?.input, 2);
  assert.equal(ratesFor('claude-sonnet-5', AFTER_INTRO)?.input, 3);
});

test('a model the table has never heard of has no rate at all', () => {
  assert.equal(ratesFor('gpt-9'), null);
  assert.equal(ratesFor(null), null);
  assert.equal(ratesFor(''), null);
});

test('cache tokens are priced off the input rate', () => {
  const rates = ratesFor('haiku')!;
  assert.equal(rates.cacheWrite, 1.25);
  assert.equal(rates.cacheRead, 0.1);
  // A million of each, so the sum is just the rate card added up.
  const cost = costOf(toTokens({ input: 1e6, output: 1e6, cacheCreate: 1e6, cacheRead: 1e6 }), rates);
  assert.equal(Math.round(cost * 100) / 100, 1 + 5 + 1.25 + 0.1);
});

test('no rate card means no cost, never a guess', () => {
  assert.equal(costOf(toTokens({ input: 1e6 }), null), 0);
});

test('unpriced tokens are carried out rather than counted as free', () => {
  const { cost, unpriced } = priceSamples([
    sample('claude-haiku-4-5', { input: 1e6 }),
    sample('some-other-model', { input: 2e6 }),
  ]);
  assert.equal(cost, 1);
  assert.equal(unpriced, 2e6);
  assert.deepEqual(unpricedModels([sample('some-other-model', { input: 1 })]), ['some-other-model']);
});

test('a model with no name at all is named in the gap', () => {
  assert.deepEqual(unpricedModels([sample(null, { input: 1 })]), ['unknown']);
});

test('nothing spent costs nothing', () => {
  assert.deepEqual(priceSamples([]), { cost: 0, unpriced: 0 });
});

test('sub-cent arithmetic is rounded rather than left as float noise', () => {
  const { cost } = priceSamples(Array.from({ length: 300 }, (_, i) => sample('haiku', { input: 7 }, AFTER_INTRO + i)));
  assert.equal(cost, Math.round(cost * 1e6) / 1e6);
  assert.ok(cost > 0);
});
