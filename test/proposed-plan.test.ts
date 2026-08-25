import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { proposedPlan } from '../server/ralphex/readout.ts';

/** The transcript as Terrarium records it: one event per line. */
function feed(lines: string[]) {
  return lines.map((text, i) => ({ seq: i + 1, stream: 'stdout', text }));
}

const PLAN = [
  '# Plan: Add a health check',
  '',
  '## Overview',
  'Ops needs a liveness endpoint.',
  '',
  '## Validation Commands',
  '- `go test ./...`',
  '',
  '### Task 1: Add the endpoint',
  '- [ ] Write the handler',
  '- [ ] Wire the route',
];

test('the plan ralphex printed is read back out of the transcript', () => {
  const found = proposedPlan(feed(['ralphex starting', ...PLAN]));
  assert.equal(found?.title, 'Add a health check');
  assert.ok(found?.text.startsWith('# Plan: Add a health check'));
  assert.ok(found?.text.includes('### Task 1: Add the endpoint'));
});

test('the question underneath it is not part of the plan', () => {
  const found = proposedPlan(
    feed([...PLAN, '', 'keep this plan?', '  1) yes', '  2) rewrite it']),
  );
  assert.ok(!found?.text.includes('keep this plan?'));
  assert.ok(!found?.text.includes('1) yes'));
  assert.ok(found?.text.trimEnd().endsWith('- [ ] Wire the route'));
});

test("a stage header ends the plan, because it is ralphex talking again", () => {
  const found = proposedPlan(feed([...PLAN, '--- task iteration 1 ---', 'working']));
  assert.ok(!found?.text.includes('task iteration'));
});

test('prose after a gap is ralphex talking over the plan, not the plan', () => {
  const found = proposedPlan(feed([...PLAN, '', '', '', 'Shall I go ahead and run it now?']));
  assert.ok(!found?.text.includes('Shall I go ahead'));
});

test('the progress log’s wrapped copy is never mistaken for the plan', () => {
  const stamped = PLAN.map((line) => `[26-06-24 11:02:03] ${line}`);
  assert.equal(proposedPlan(feed(stamped)), null);
});

test('a plan file it only named is reported by path', () => {
  const found = proposedPlan(feed(['ralphex starting', 'wrote plan to docs/plans/health-check.md']));
  assert.equal(found?.path, 'docs/plans/health-check.md');
  assert.equal(found?.text, '');
  assert.equal(found?.title, null);
});

test('a markdown file outside a plans folder is not a plan', () => {
  assert.equal(proposedPlan(feed(['see README.md for details'])), null);
  assert.equal(proposedPlan(feed(['edited src/notes/thing.md'])), null);
});

test('a revised plan names its new file, and the newest name wins', () => {
  const found = proposedPlan(
    feed(['wrote docs/plans/first.md', 'rewriting', 'wrote docs/plans/second.md']),
  );
  assert.equal(found?.path, 'docs/plans/second.md');
});

test('a heading with no tasks or boxes under it is not a plan', () => {
  assert.equal(proposedPlan(feed(['# Some heading', 'just prose'])), null);
});

test('a transcript with no plan in it says so', () => {
  assert.equal(proposedPlan(feed(['ralphex starting', 'reading the repository'])), null);
});

test('the plan printed and the file named come back together', () => {
  const found = proposedPlan(feed([...PLAN, '', 'wrote docs/plans/health-check.md']));
  assert.equal(found?.path, 'docs/plans/health-check.md');
  assert.ok(found?.text.includes('### Task 1'));
});

test('the lines the plan was printed on are named, so they can be folded away', () => {
  const found = proposedPlan(feed(['ralphex starting', ...PLAN, '', 'keep this plan?']));
  // Line 1 is "ralphex starting"; the plan starts on the next one.
  assert.equal(found?.drawnFrom[0], 2);
  assert.equal(found?.drawnFrom[1], 1 + PLAN.length);
});

test('a plan that was only named was never drawn, so there is nothing to fold', () => {
  const found = proposedPlan(feed(['wrote docs/plans/health-check.md']));
  assert.deepEqual(found?.drawnFrom, [0, 0]);
});
