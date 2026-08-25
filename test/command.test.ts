import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildCommand, formatCommand, quoteArg, RUN_MODES } from '../server/ralphex/command.ts';

test('the interview carries the description as an argument', () => {
  const built = buildCommand({ mode: 'plan', planDescription: 'a health endpoint' });
  assert.deepEqual(built.args, ['--plan', 'a health endpoint', '--no-color']);
  assert.equal(built.launchable, true);
});

test('an interview with nothing to go on will not launch', () => {
  const built = buildCommand({ mode: 'plan', planDescription: '   ' });
  assert.equal(built.launchable, false);
  assert.match(built.errors[0], /Say what you want built/);
});

test('a run puts the plan path last, where ralphex expects it', () => {
  const built = buildCommand({ mode: 'execute', planPath: 'docs/plans/x.md' });
  assert.equal(built.args.at(-1), 'docs/plans/x.md');
});

test('growing refuses to run without a plan to work', () => {
  assert.equal(buildCommand({ mode: 'execute' }).launchable, false);
  assert.match(buildCommand({ mode: 'execute' }).errors[0], /needs a plan file/);
});

test('colour is off unless asked for: the stream is parsed, not read', () => {
  assert.ok(buildCommand({ mode: 'plan', planDescription: 'a thing' }).args.includes('--no-color'));
  assert.ok(!buildCommand({ mode: 'plan', planDescription: 'a thing', color: true }).args.includes('--no-color'));
});

test('--worktree is never built: the specimen already is one', () => {
  const built = buildCommand({ mode: 'execute', planPath: 'p.md', maxIterations: 3 });
  assert.ok(!built.args.includes('--worktree'));
});

test('models come through as flags', () => {
  const built = buildCommand({
    mode: 'execute',
    planPath: 'p.md',
    planModel: 'haiku',
    taskModel: 'haiku',
    reviewModel: 'sonnet:low',
  });
  assert.ok(built.args.includes('--plan-model=haiku'));
  assert.ok(built.args.includes('--review-model=sonnet:low'));
});

test('a nonsense model is refused rather than passed on', () => {
  const built = buildCommand({ mode: 'execute', planPath: 'p.md', taskModel: 'sonnet; rm -rf /' });
  assert.equal(built.launchable, false);
  assert.match(built.errors[0], /Task model/);
});

test('iteration caps are bounded whole numbers', () => {
  assert.ok(buildCommand({ mode: 'execute', planPath: 'p.md', maxIterations: 12 }).args.includes('--max-iterations=12'));
  assert.equal(buildCommand({ mode: 'execute', planPath: 'p.md', maxIterations: 0 }).launchable, false);
  assert.equal(buildCommand({ mode: 'execute', planPath: 'p.md', maxIterations: 9.5 }).launchable, false);
  assert.equal(buildCommand({ mode: 'execute', planPath: 'p.md', maxIterations: 900 }).launchable, false);
});

test('durations have to look like durations', () => {
  assert.ok(buildCommand({ mode: 'execute', planPath: 'p.md', idleTimeout: '45m' }).args.includes('--idle-timeout=45m'));
  assert.equal(buildCommand({ mode: 'execute', planPath: 'p.md', idleTimeout: 'a while' }).launchable, false);
});

test('a plan path has to be markdown and cannot pose as a flag', () => {
  assert.equal(buildCommand({ mode: 'execute', planPath: 'notes.txt' }).launchable, false);
  assert.equal(buildCommand({ mode: 'execute', planPath: '--help.md' }).launchable, false);
});

test('a base ref with shell syntax in it is refused', () => {
  assert.equal(buildCommand({ mode: 'execute', planPath: 'p.md', baseRef: 'main; rm -rf /' }).launchable, false);
  assert.ok(
    buildCommand({ mode: 'execute', planPath: 'p.md', baseRef: 'origin/main' }).args.includes('--base-ref=origin/main'),
  );
});

test('an unknown mode is a refusal, not a guess', () => {
  const built = buildCommand({ mode: 'freestyle' });
  assert.equal(built.launchable, false);
  assert.match(built.errors[0], /Unknown run mode/);
});

/**
 * Two things and no third. There is no dropdown on the bench and nothing behind
 * one either: growing is the whole loop, every time.
 */
test('there are two ways to run ralphex: the interview and the loop', () => {
  assert.deepEqual(Object.keys(RUN_MODES), ['plan', 'execute']);
  assert.equal(buildCommand({ mode: 'tasks-only' }).launchable, false);
  assert.equal(buildCommand({ mode: 'review' }).launchable, false);
});

test('quoting is only ever for writing a command down', () => {
  assert.equal(quoteArg('simple'), 'simple');
  assert.equal(quoteArg('two words'), "'two words'");
  assert.equal(quoteArg(''), "''");
  assert.equal(formatCommand('ralphex', ['--plan', 'a b']), "ralphex --plan 'a b'");
});
