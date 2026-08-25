import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addTokens, groupTotals, toTokens, totalOf, totalsFor, type UsageSample } from '../server/ralphex/usage/model.ts';
import { buildTimeline, parseSection, stageAt } from '../server/ralphex/usage/stages.ts';
import { createClaudeCodeSource, sampleFrom, slugFor } from '../server/ralphex/usage/claude-code.ts';
import { UsageMeter } from '../server/ralphex/usage/meter.ts';

function sample(ts: number, tokensIn: Partial<Record<string, number>> = {}, extra: Partial<UsageSample> = {}): UsageSample {
  return {
    source: 'test',
    key: `k${ts}${extra.agent ?? ''}${extra.model ?? ''}`,
    ts,
    model: 'claude-haiku-4-5',
    sessionId: 's1',
    agent: 'main',
    tokens: toTokens(tokensIn),
    ...extra,
  };
}

// -- the shape ---------------------------------------------------------------

test('nonsense coerces to zero rather than poisoning a total', () => {
  const tokens = toTokens({ input: '12', output: -4, cacheRead: null, cacheCreate: undefined });
  assert.deepEqual(tokens, { input: 12, output: 0, cacheCreate: 0, cacheRead: 0, reasoning: 0 });
});

test('thinking tokens travel alongside the total, never inside it', () => {
  const tokens = toTokens({ input: 10, output: 90, reasoning: 40 });
  assert.equal(totalOf(tokens), 100);
  assert.equal(tokens.reasoning, 40);
});

test('adding folds every bucket, thinking included', () => {
  const into = toTokens({ input: 1, reasoning: 2 });
  addTokens(into, toTokens({ input: 4, output: 5, reasoning: 3 }));
  assert.deepEqual(into, { input: 5, output: 5, cacheCreate: 0, cacheRead: 0, reasoning: 5 });
});

test('totals carry the span they cover', () => {
  const totals = totalsFor([sample(100, { input: 5 }), sample(300, { output: 7 })]);
  assert.equal(totals.total, 12);
  assert.equal(totals.samples, 2);
  assert.equal(totals.firstAt, 100);
  assert.equal(totals.lastAt, 300);
});

test('an empty run totals to nothing, not to null', () => {
  const totals = totalsFor([]);
  assert.equal(totals.total, 0);
  assert.equal(totals.firstAt, null);
});

test('grouping puts the heaviest first and drops what the key refuses', () => {
  const groups = groupTotals(
    [
      sample(1, { input: 10 }, { model: 'haiku' }),
      sample(2, { input: 90 }, { model: 'sonnet' }),
      sample(3, { input: 5 }, { model: null }),
    ],
    (s) => s.model,
  );
  assert.deepEqual(groups.map((g) => g.key), ['sonnet', 'haiku']);
  assert.equal(groups[0].total, 90);
});

// -- the stages --------------------------------------------------------------

test("ralphex's own section headers are read as stage boundaries", () => {
  assert.deepEqual(parseSection('--- task iteration 3 ---'), {
    label: 'task iteration 3',
    kind: 'task',
    phase: 'task',
    index: 3,
  });
  assert.equal(parseSection('--- claude review 1: critical/major ---')?.kind, 'review');
  assert.equal(parseSection('--- codex iteration 2 ---')?.kind, 'external');
  assert.equal(parseSection('--- finalize ---')?.kind, 'finalize');
});

test('a line of prose with dashes in it is not a stage', () => {
  assert.equal(parseSection('well -- maybe -- not'), null);
  assert.equal(parseSection('---  ---'), null);
});

test('an unrecognised section is still a boundary, phased by what we guessed', () => {
  const section = parseSection('--- something new ---', 'review');
  assert.equal(section?.kind, 'other');
  assert.equal(section?.phase, 'review');
});

test('a timeline starts at the run, not at its first line', () => {
  const run = { startedAt: new Date(1_000).toISOString(), endedAt: new Date(9_000).toISOString() };
  const { stages, sectioned } = buildTimeline(
    [
      { ts: 2_000, phase: 'setup', text: 'config loaded' },
      { ts: 3_000, phase: 'task', text: '--- task iteration 1 ---' },
      { ts: 4_000, phase: 'task', text: 'working' },
    ],
    run,
  );
  assert.equal(sectioned, true);
  assert.equal(stages.length, 2);
  assert.equal(stages[0].label, 'startup');
  assert.equal(stages[0].from, 1_000);
  assert.equal(stages[0].to, 3_000);
  assert.equal(stages[1].to, 9_000);
});

test('with no section headers, phase changes become the stages', () => {
  const { stages, sectioned } = buildTimeline(
    [
      { ts: 10, phase: 'setup', text: 'starting' },
      { ts: 20, phase: 'task', text: 'a task' },
      { ts: 30, phase: 'task', text: 'still the task' },
    ],
    { startedAt: new Date(5).toISOString(), endedAt: null },
  );
  assert.equal(sectioned, false);
  assert.deepEqual(stages.map((s) => s.label), ['setup', 'task']);
  assert.equal(stages[0].from, 5);
});

test('a sample outside the timeline is clamped to the nearest stage, never dropped', () => {
  const { stages } = buildTimeline(
    [{ ts: 100, phase: 'task', text: '--- task iteration 1 ---' }],
    { startedAt: new Date(50).toISOString(), endedAt: new Date(200).toISOString() },
  );
  assert.equal(stageAt(stages, 1)?.label, 'startup');
  assert.equal(stageAt(stages, 150)?.label, 'task iteration 1');
  assert.equal(stageAt(stages, 10_000)?.label, 'task iteration 1');
  assert.equal(stageAt([], 5), null);
});

// -- reading Claude Code's transcripts ---------------------------------------

test("the project slug is Claude Code's own", () => {
  assert.equal(slugFor('/Users/x/dev/repo'), '-Users-x-dev-repo');
});

test('an assistant turn inside the window becomes a sample', () => {
  const record = {
    type: 'assistant',
    timestamp: new Date(1_000).toISOString(),
    cwd: '/w',
    sessionId: 'abc',
    requestId: 'req1',
    isSidechain: true,
    message: {
      id: 'msg1',
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5 },
    },
  };
  const result = sampleFrom(record, { dirs: ['/w'], from: 0, to: 2_000 });
  assert.equal(result?.agent, 'subagent');
  assert.equal(result?.key, 'req1:msg1');
  assert.equal(totalOf(result!.tokens), 12);
});

test('turns from another checkout, another time, or no model at all are not ours', () => {
  const base = {
    type: 'assistant',
    timestamp: new Date(1_000).toISOString(),
    cwd: '/w',
    message: { id: 'm', model: 'haiku', usage: { input_tokens: 1 } },
  };
  assert.equal(sampleFrom({ ...base, cwd: '/elsewhere' }, { dirs: ['/w'], from: 0, to: 2_000 }), null);
  assert.equal(sampleFrom(base, { dirs: ['/w'], from: 5_000, to: null }), null);
  assert.equal(sampleFrom({ ...base, type: 'user' }, { dirs: ['/w'], from: 0, to: null }), null);
  assert.equal(
    sampleFrom({ ...base, message: { ...base.message, model: '<synthetic>' } }, { dirs: ['/w'], from: 0, to: null }),
    null,
  );
});

test('a turn written just after the run ended still counts', () => {
  const record = {
    type: 'assistant',
    timestamp: new Date(10_000).toISOString(),
    cwd: '/w',
    message: { id: 'm', model: 'haiku', usage: { input_tokens: 1 } },
  };
  assert.ok(sampleFrom(record, { dirs: ['/w'], from: 0, to: 2_000 }));
  assert.equal(sampleFrom(record, { dirs: ['/w'], from: 0, to: -20_000 }), null);
});

test('the meter reads a transcript off disk and files it under a stage', () => {
  const root = mkdtempSync(join(tmpdir(), 'terrarium-usage-'));
  const cwd = '/some/worktree';
  const dir = join(root, slugFor(cwd));
  mkdirSync(dir, { recursive: true });
  const line = (ts: number, tokens: number) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(ts).toISOString(),
      cwd,
      sessionId: 's',
      requestId: `r${ts}`,
      message: { id: `m${ts}`, model: 'claude-haiku-4-5', usage: { input_tokens: tokens } },
    });
  const started = Date.now();
  writeFileSync(join(dir, 's.jsonl'), `${line(started + 10, 5)}\n${line(started + 5_000, 50)}\n`);

  const meter = new UsageMeter([cwd], [createClaudeCodeSource({ root })]);
  const report = meter.read(
    [
      { ts: started + 1, phase: 'setup', text: 'starting' },
      { ts: started + 1_000, phase: 'task', text: '--- task iteration 1 ---' },
    ],
    { startedAt: new Date(started).toISOString(), endedAt: null, live: true },
  );

  assert.equal(report.available, true);
  assert.equal(report.totals.total, 55);
  assert.equal(report.stages.find((s) => s.label === 'startup')?.total, 5);
  assert.equal(report.stages.find((s) => s.label === 'task iteration 1')?.total, 50);

  // And a price on all of it, worked out from the model each turn ran on.
  // Haiku input is $1 per million, so 55 tokens is 55 millionths of a dollar.
  assert.equal(report.totals.cost, 0.000055);
  assert.equal(report.totals.unpriced, 0);
  assert.equal(report.stages.find((s) => s.label === 'task iteration 1')?.cost, 0.00005);
  assert.equal(report.models[0].key, 'claude-haiku-4-5');
  assert.equal(report.models[0].cost, 0.000055);
  assert.equal(report.pricing.estimate, true);
  assert.match(report.pricing.url, /claude\.com\/pricing/);

  // Reading again must not double-count: the cursor remembers where it stopped.
  const again = meter.read([], { startedAt: new Date(started).toISOString(), endedAt: null, live: true });
  assert.equal(again.totals.total, 55);
});

test('no transcripts at all is an answer, not a failure', () => {
  const meter = new UsageMeter(['/nowhere'], [createClaudeCodeSource({ root: '/definitely/not/here' })]);
  const report = meter.read([], { startedAt: new Date().toISOString(), endedAt: null, live: false });
  assert.equal(report.available, false);
  assert.equal(report.sources[0].available, false);
  assert.match(String(report.sources[0].reason), /No Claude Code transcripts/);
});

test('a model with no published rate is counted, said out loud, and never costed', () => {
  const root = mkdtempSync(join(tmpdir(), 'terrarium-unpriced-'));
  const cwd = '/some/other/worktree';
  const dir = join(root, slugFor(cwd));
  mkdirSync(dir, { recursive: true });
  const started = Date.now();
  writeFileSync(
    join(dir, 's.jsonl'),
    `${JSON.stringify({
      type: 'assistant',
      timestamp: new Date(started + 10).toISOString(),
      cwd,
      sessionId: 's',
      requestId: 'r1',
      message: { id: 'm1', model: 'some-model-nobody-priced', usage: { input_tokens: 1000 } },
    })}\n`,
  );

  const meter = new UsageMeter([cwd], [createClaudeCodeSource({ root })]);
  const report = meter.read([], { startedAt: new Date(started).toISOString(), endedAt: null, live: false });

  assert.equal(report.totals.total, 1000);
  assert.equal(report.totals.cost, 0);
  assert.equal(report.totals.unpriced, 1000);
  assert.ok(report.caveats.some((c) => c.includes('some-model-nobody-priced')));
});
