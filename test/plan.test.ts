import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { branchNameForPlan, parsePlan, slugify, withoutDatePrefix } from '../server/ralphex/plan.ts';

const GOOD = `# Plan: Add a health check

## Overview
Ops needs a liveness endpoint.

## Validation Commands
- \`go test ./...\`
- \`golangci-lint run\`

### Task 1: Add the endpoint
- [x] Write the handler
- [ ] Wire the route

### Task 2: Cover it
- [ ] Add a test
`;

test('reads the shape ralphex writes', () => {
  const plan = parsePlan(GOOD);
  assert.equal(plan.title, 'Add a health check');
  assert.equal(plan.overview, 'Ops needs a liveness endpoint.');
  assert.deepEqual(
    plan.validationCommands.map((c) => c.command),
    ['go test ./...', 'golangci-lint run'],
  );
  assert.equal(plan.tasks.length, 2);
  assert.equal(plan.tasks[0].description, 'Add the endpoint');
  assert.equal(plan.valid, true);
});

test('counts progress the way ralphex ticks it', () => {
  const { progress } = parsePlan(GOOD);
  assert.deepEqual(progress.checkboxes, { done: 1, total: 3 });
  assert.deepEqual(progress.tasks, { done: 0, total: 2 });
  assert.equal(progress.percent, 33);
  assert.equal(progress.complete, false);
});

test('a fully ticked plan reads as complete', () => {
  const { progress } = parsePlan(GOOD.replaceAll('- [ ]', '- [x]'));
  assert.equal(progress.percent, 100);
  assert.equal(progress.complete, true);
});

test('a checkbox outside a task is an error, because it costs an iteration', () => {
  const plan = parsePlan(`# Plan: Thing

## Overview
Why.

## Validation Commands
- \`make test\`

## Notes
- [ ] a stray box

### Task 1: Do it
- [ ] the work
`);
  const stray = plan.diagnostics.find((d) => d.code === 'E003');
  assert.ok(stray, 'expected E003');
  assert.equal(stray?.severity, 'error');
  assert.equal(stray?.line, 10);
  assert.equal(plan.valid, false);
});

// The interview's own plans have neither a "## Validation Commands" section
// nor a "# Plan:" prefix — ralphex's plan prompt writes a bare title and no
// such section, and nothing in ralphex reads one. Calling either a problem put
// a problem on every plan Terrarium grew, and stopped the bench working them.
test('the shape the interview actually writes has nothing wrong with it', () => {
  const plan = parsePlan(`# Add a health check

## Overview
Ops needs a liveness endpoint.

## Context
- Files involved: \`server/main.ts\`

## Implementation Steps

### Task 1: Add the endpoint
- [ ] Write the handler
`);
  assert.equal(plan.title, 'Add a health check');
  assert.deepEqual(plan.diagnostics, []);
  assert.equal(plan.valid, true);
});

test('no tasks at all is fatal', () => {
  const plan = parsePlan('# Plan: T\n\n## Validation Commands\n- `make test`\n');
  assert.ok(plan.diagnostics.some((d) => d.code === 'E004'));
});

test('a task heading missing its colon is caught, not silently ignored', () => {
  const plan = parsePlan(`# Plan: T

## Validation Commands
- \`make test\`

### Task 1 do the thing
- [ ] work
`);
  assert.ok(plan.diagnostics.some((d) => d.code === 'E006'));
});

test('fenced code is opaque: an example task is not a task', () => {
  const plan = parsePlan(`# Plan: T

## Overview
Like this:

\`\`\`markdown
### Task 9: not real
- [ ] not real either
\`\`\`

## Validation Commands
- \`make test\`

### Task 1: real
- [ ] real work
`);
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.progress.checkboxes.total, 1);
});

test('an unbackticked validation command still counts, with a warning', () => {
  const plan = parsePlan('# Plan: T\n\n## Validation Commands\n- make test\n\n### Task 1: x\n- [ ] y\n');
  assert.deepEqual(plan.validationCommands.map((c) => c.command), ['make test']);
  assert.ok(plan.diagnostics.some((d) => d.code === 'W005'));
});

test('iterations are tasks under another name', () => {
  const plan = parsePlan('# Plan: T\n\n## Validation Commands\n- `t`\n\n### Iteration 1: x\n- [ ] y\n');
  assert.equal(plan.tasks[0].kind, 'Iteration');
  assert.equal(plan.valid, true);
});

test('duplicate task numbers are flagged', () => {
  const plan = parsePlan(
    '# Plan: T\n\n## Validation Commands\n- `t`\n\n### Task 1: a\n- [ ] x\n\n### Task 1: b\n- [ ] y\n',
  );
  assert.ok(plan.diagnostics.some((d) => d.code === 'W003'));
});

test('nothing at all comes back as diagnostics, never a throw', () => {
  const plan = parsePlan('');
  assert.equal(plan.title, null);
  assert.equal(plan.valid, false);
  assert.ok(plan.diagnostics.length > 0);
});

test('the branch name is the plan filename', () => {
  assert.equal(branchNameForPlan('docs/plans/add-health-check.md'), 'add-health-check');
  assert.equal(branchNameForPlan('add-health-check.MD'), 'add-health-check');
});

/**
 * The date belongs to the plans folder, where it keeps the files in order. On
 * the front of a worktree folder it is eight digits between the developer and
 * what the work is, so it is taken off on the way to the branch.
 */
test('the date ralphex stamps on a plan file never reaches the branch', () => {
  assert.equal(branchNameForPlan('docs/plans/20260824-donut-background.md'), 'donut-background');
  assert.equal(branchNameForPlan('docs/plans/2026-08-24-donut-background.md'), 'donut-background');
  assert.equal(withoutDatePrefix('20260824-donut-background'), 'donut-background');
  // A name that is only a date keeps it: something is better than nothing.
  assert.equal(withoutDatePrefix('20260824'), '20260824');
  // And a number that is not a date is part of the name.
  assert.equal(branchNameForPlan('docs/plans/2026-fixes.md'), '2026-fixes');
  assert.equal(branchNameForPlan('docs/plans/v2-donut-background.md'), 'v2-donut-background');
});

test('slugs are branch-safe and never empty', () => {
  assert.equal(slugify('Add a Health Check!'), 'add-a-health-check');
  assert.equal(slugify('  '), 'untitled-plan');
  assert.equal(slugify("don't do this"), 'dont-do-this');
});
