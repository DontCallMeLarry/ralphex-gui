import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parsePlan } from '../server/ralphex/plan.ts';
import { changeItems, revisePlan, revisePlanName, stepsOf } from '../server/ralphex/revise.ts';

const WORK = {
  title: 'Hello World with Donut Background',
  built: ['Create HTML structure with basic styling', 'Style the donut background with sprinkles'],
  branch: 'hello-world-donut-background',
  commits: 6,
  files: 3,
};

test('one line, one step', () => {
  assert.deepEqual(changeItems('make the donut pink\nsprinkles are too small'), [
    'make the donut pink',
    'sprinkles are too small',
  ]);
});

test('the markers people type are not part of what they asked for', () => {
  assert.deepEqual(changeItems('- make it pink\n* bigger sprinkles\n2. centre it\n- [ ] and a title'), [
    'make it pink',
    'bigger sprinkles',
    'centre it',
    'and a title',
  ]);
});

test('a paragraph is one thing being asked for, not eight', () => {
  const prose = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join('\n');
  const items = changeItems(prose);
  assert.equal(items.length, 1);
  assert.match(items[0], /^line 1 line 2 /);
});

test('blank lines are not steps', () => {
  assert.deepEqual(changeItems('\n\nmake it pink\n\n   \nbigger sprinkles\n'), [
    'make it pink',
    'bigger sprinkles',
  ]);
});

test('a note with nothing in it is not a plan', () => {
  assert.throws(() => revisePlan(WORK, '   \n  \n'), /Say what you want changed/);
});

test('the plan it writes is one ralphex will not trip over', () => {
  const analysis = parsePlan(revisePlan(WORK, 'make the donut pink\nsprinkles are too small'));
  assert.equal(analysis.valid, true);
  assert.deepEqual(analysis.diagnostics.filter((d) => d.severity === 'error'), []);
  assert.equal(analysis.title, 'Hello World with Donut Background: changes');
  assert.deepEqual(
    analysis.tasks.map((t) => t.description),
    ['make the donut pink', 'sprinkles are too small'],
  );
  assert.equal(analysis.progress.checkboxes.total, 2);
  assert.equal(analysis.progress.checkboxes.done, 0);
});

test('the overview says the work is already there, and is not to be redone', () => {
  const analysis = parsePlan(revisePlan(WORK, 'make the donut pink'));
  assert.match(analysis.overview, /already built/);
  assert.match(analysis.overview, /hello-world-donut-background/);
  assert.match(analysis.overview, /6 commits over 3 files/);
  assert.match(analysis.overview, /rebuild it, re-plan it or start again/);
  // What it is, so a fresh run does not go looking for it.
  assert.match(analysis.overview, /Create HTML structure with basic styling/);
});

test('a pasted checkbox never lands outside a task', () => {
  // A checkbox loose in the overview is an error ralphex pays for in extra
  // loop passes, so the note is quoted rather than copied in.
  const analysis = parsePlan(revisePlan(WORK, '- [ ] make it pink'));
  assert.deepEqual(analysis.diagnostics.filter((d) => d.severity === 'error'), []);
  assert.equal(analysis.progress.checkboxes.total, 1);
});

test('a long line is shortened for the heading and whole on the box', () => {
  const long = `make the donut ${'very '.repeat(40)}pink`;
  const analysis = parsePlan(revisePlan(WORK, long));
  assert.ok(analysis.tasks[0].description.length <= 90, analysis.tasks[0].description);
  assert.match(analysis.tasks[0].description, /…$/);
  assert.equal(analysis.tasks[0].checkboxes[0].text, long);
});

test('a specimen with no plan of its own still gets a usable one', () => {
  const analysis = parsePlan(
    revisePlan({ title: null, built: [], branch: 'stray-worktree', commits: null, files: null }, 'fix the header'),
  );
  assert.equal(analysis.valid, true);
  assert.equal(analysis.title, 'stray-worktree: changes');
});

test('the name it picks is not the one the branch already answers to', () => {
  const name = revisePlanName('Hello World with Donut Background', () => false, new Date('2026-08-25T10:00:00Z'));
  assert.equal(name, '20260825-hello-world-with-donut-background-changes.md');
});

test('two changes on one day do not fight over a filename', () => {
  const taken = new Set(['20260825-donut-changes.md', '20260825-donut-changes-2.md']);
  const name = revisePlanName('Donut', (n) => taken.has(n), new Date('2026-08-25T10:00:00Z'));
  assert.equal(name, '20260825-donut-changes-3.md');
});

test('the steps of a finished plan are what the summary lists', () => {
  const done = `# Donut

## Overview
A donut.

### Task 1: Build it
- [x] one

### Task 2: Sprinkle it
- [x] two
`;
  assert.deepEqual(stepsOf(done), ['Build it', 'Sprinkle it']);
});
