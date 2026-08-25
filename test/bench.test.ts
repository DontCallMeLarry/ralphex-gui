import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SproutSession } from '../server/sprout.ts';
import { passesFor, TendManager } from '../server/tend.ts';
import { parsePlan } from '../server/ralphex/plan.ts';
import { inspectChanges } from '../server/ralphex/changes.ts';
import { stepsOf, writeChangePlan } from '../server/ralphex/revise.ts';
import { newAvatarSeed, newSpecimenId } from '../server/state.ts';
import type { Specimen } from '../server/types.ts';
import type { TerrariumConfig } from '../server/config.ts';
import { git, makeTerrarium, until } from './helpers.ts';

/**
 * The tending bench end to end: ralphex works the plan inside the specimen's
 * own worktree, ticking the plan's checkboxes and committing as it goes, and
 * the branch afterwards is what it left behind.
 */

/** The question card that is open right now, if any. */
function open(sprout: SproutSession) {
  const closed = new Set(
    sprout.session.events.filter((e) => e.type === 'question_closed').map((e) => String(e.data.requestId)),
  );
  return sprout.session.events.find((e) => e.type === 'question' && !closed.has(String(e.data.requestId)));
}

/** Sprout one specimen the way the flow does, and hand back its record. */
async function grow(config: TerrariumConfig, repo: string, repoPath: string): Promise<Specimen> {
  const sprout = new SproutSession(config, repo, repoPath, 'somewhere to check the service is alive');
  sprout.start();
  await until('a question', () => Boolean(open(sprout)));
  sprout.session.answer(String(open(sprout)!.data.requestId), 'health check');

  // Taking the plan is what makes the interview write it out, and then what
  // pots the seedling. There is no second answer to give.
  await until('the plan', () => sprout.hasPlan);
  if (!(await sprout.take())) {
    await until('the plan file', () => sprout.ready);
    await sprout.take();
  }
  const outcome = sprout.outcome!;
  return {
    id: newSpecimenId(),
    repo,
    branch: outcome.branch,
    worktreePath: outcome.worktreePath,
    createdAt: new Date().toISOString(),
    avatarSeed: newAvatarSeed(),
    checklist: { sandbox: false, qa: false, production: false },
    notes: '',
    origin: 'sprouted',
    archivedAt: null,
    minimized: false,
    planPath: outcome.planPath,
    lastRun: null,
  };
}

/**
 * Nothing is asked on the way to the button, so the cap on the loop is read off
 * the plan: a pass per step, a pass per step that has to come round again, and
 * a ceiling so a loop that cannot finish stops paying to not finish.
 */
test('how many passes a run gets is read off the plan', () => {
  assert.equal(passesFor(3), 8, 'a small plan is not cut off by its own smallness');
  assert.equal(passesFor(12), 24);
  assert.equal(passesFor(400), 60, 'and there is always a ceiling');
});

test('the bench works the plan in the specimen worktree and ticks it off', async () => {
  const { repo, repoPath, config } = makeTerrarium();
  const specimen = await grow(config, repo, repoPath);

  const before = parsePlan(readFileSync(join(specimen.worktreePath, specimen.planPath!), 'utf8'));
  assert.equal(before.progress.checkboxes.done, 0);
  assert.equal(before.progress.checkboxes.total, 3);

  const tends = new TendManager(config);
  const tend = tends.create(specimen, repoPath);
  await until('the run to finish', () => !tend.session.live, 40_000);
  assert.equal(tend.session.status, 'succeeded', tend.session.error ?? '');

  // The plan file is ralphex's progress record, and it is now all ticked.
  const after = parsePlan(readFileSync(join(specimen.worktreePath, specimen.planPath!), 'utf8'));
  assert.equal(after.progress.complete, true);
  assert.equal(tend.plan?.analysis?.progress.checkboxes.done, 3);

  // ralphex commits per step and never pushes: the branch is the deliverable.
  const changes = await inspectChanges(specimen.worktreePath, specimen.branch, repoPath);
  assert.equal(changes.available, true);
  assert.equal(changes.base, 'main');
  assert.ok((changes.commitCount ?? 0) >= 3, `expected commits, got ${changes.commitCount}`);
  assert.ok(changes.commits?.some((c) => c.subject === 'step 1'));

  // And nothing was left uncommitted behind it.
  assert.equal(git(specimen.worktreePath, 'status', '--porcelain').trim(), '');
});

/**
 * Reviewing a change means reading the diff, and reading a diff happens in an
 * editor. So whatever a run leaves loose is in the index by the time anybody
 * is told about it: the worktree opens on the change rather than on a folder
 * with something different in it somewhere.
 */
test('whatever a run left loose is staged, and counted rather than assumed', async () => {
  const { repo, repoPath, config } = makeTerrarium();
  const specimen = await grow(config, repo, repoPath);

  // A run that stopped part way through leaves work behind that never got a
  // commit — including files git has never seen.
  writeFileSync(join(specimen.worktreePath, 'half-done.txt'), 'left behind\n');
  writeFileSync(join(specimen.worktreePath, 'README.md'), '# widget\n\nedited\n');

  const changes = await inspectChanges(specimen.worktreePath, specimen.branch, repoPath);
  assert.equal(changes.uncommitted, 2);
  assert.equal(changes.staged, 2, 'both are in the index, the untracked one included');
  // Which is the truth on disk, not a claim about it.
  assert.equal(git(specimen.worktreePath, 'diff', '--cached', '--name-only').trim().split('\n').length, 2);
});

test("ralphex's own stage headers become the transcript's chapter breaks", async () => {
  const { repo, repoPath, config } = makeTerrarium();
  const specimen = await grow(config, repo, repoPath);
  const tends = new TendManager(config);
  const tend = tends.create(specimen, repoPath);
  await until('the run to finish', () => !tend.session.live, 40_000);

  const stages = tend.session.events.filter((e) => e.type === 'stage').map((e) => String(e.data.label));
  assert.deepEqual(stages, [
    'task iteration 1',
    'task iteration 2',
    'task iteration 3',
    'review 1: critical/major',
    'finalize',
  ]);
  // A stage line is a chapter break, never one more grey line of machinery.
  assert.ok(!tend.session.events.some((e) => e.type === 'line' && String(e.data.text).startsWith('--- task')));
});

test('two runs cannot fight over one worktree', async () => {
  const { repo, repoPath, config } = makeTerrarium();
  const specimen = await grow(config, repo, repoPath);
  const tends = new TendManager(config);
  const first = tends.create(specimen, repoPath);
  assert.throws(() => tends.create(specimen, repoPath), /already working in this worktree/);
  first.session.cancel();
  await until('the run to stop', () => !first.session.live, 40_000);
});

test('stopping a run says so in a sentence rather than in its own output', async () => {
  const { repo, repoPath, config } = makeTerrarium();
  const specimen = await grow(config, repo, repoPath);
  const tends = new TendManager(config);
  const tend = tends.create(specimen, repoPath);

  await until('the run to get going', () => tend.session.events.some((e) => e.type === 'line'));
  tend.session.cancel();
  await until('the run to stop', () => !tend.session.live, 40_000);

  assert.equal(tend.session.status, 'cancelled');
  const said = tend.session.events.find((e) => e.type === 'session_error');
  assert.equal(String(said?.data.message), 'You stopped this run.');
});

test('a specimen with no plan cannot be told to work one', async () => {
  const { repo, repoPath, config } = makeTerrarium();
  const specimen = await grow(config, repo, repoPath);
  git(specimen.worktreePath, 'rm', '-q', specimen.planPath!);
  git(specimen.worktreePath, 'commit', '-q', '-m', 'drop the plan');

  const tends = new TendManager(config);
  const tend = tends.create({ ...specimen, planPath: null }, repoPath);
  await until('the run to give up', () => !tend.session.live, 20_000);
  assert.equal(tend.session.status, 'failed');
  assert.match(String(tend.session.error), /needs a plan file/);
});

/**
 * Finished work with something wrong in it does not go back through the
 * interview. The note becomes a short plan of its own — what is already built,
 * then the changes, one step per line — committed onto the branch, and the loop
 * runs that. The finished plan is left exactly as it was: it is the record of
 * what was built, and the next run has no business paying to read it again.
 */
test('a change to finished work is a new small plan, and the loop runs it', async () => {
  const { repo, repoPath, config } = makeTerrarium();
  const specimen = await grow(config, repo, repoPath);
  const built = specimen.planPath!;

  const tends = new TendManager(config);
  const first = tends.create(specimen, repoPath);
  await until('the first run to finish', () => !first.session.live, 40_000);
  assert.equal(parsePlan(readFileSync(join(specimen.worktreePath, built), 'utf8')).progress.complete, true);

  const before = readFileSync(join(specimen.worktreePath, built), 'utf8');
  const changes = await inspectChanges(specimen.worktreePath, specimen.branch, repoPath);
  const planPath = await writeChangePlan(
    specimen.worktreePath,
    config.plansDir,
    {
      title: 'Health check',
      built: stepsOf(before),
      branch: specimen.branch,
      commits: changes.commitCount ?? null,
      files: changes.fileCount ?? null,
    },
    'the endpoint should be /healthz\nsay so in the readme',
  );

  // A file of its own, not the finished one with more boxes on the end.
  assert.notEqual(planPath, built);
  assert.equal(readFileSync(join(specimen.worktreePath, built), 'utf8'), before, 'the finished plan is untouched');

  // On the branch, so ralphex can tick it where it works.
  assert.equal(git(specimen.worktreePath, 'status', '--porcelain').trim(), '');
  assert.ok(git(specimen.worktreePath, 'log', '-1', '--format=%s').includes('Add plan:'));

  const asked = parsePlan(readFileSync(join(specimen.worktreePath, planPath), 'utf8'));
  assert.equal(asked.valid, true);
  assert.equal(asked.progress.checkboxes.total, 2);
  assert.match(asked.overview, /already built/);

  // And the loop works it, in the same worktree, off the new plan.
  const second = tends.create({ ...specimen, planPath }, repoPath);
  assert.equal(second.planPath, planPath, 'the run is on the change plan, not the finished one');
  await until('the second run to finish', () => !second.session.live, 40_000);
  assert.equal(second.session.status, 'succeeded', second.session.error ?? '');
  assert.equal(parsePlan(readFileSync(join(specimen.worktreePath, planPath), 'utf8')).progress.complete, true);
});
