import { strict as assert } from 'node:assert';
import { test, type TestContext } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SproutSession } from '../server/sprout.ts';
import { parsePlan } from '../server/ralphex/plan.ts';
import { listPlanFiles } from '../server/ralphex/plans.ts';
import { git, makeTerrarium, until } from './helpers.ts';

/**
 * The sprout flow end to end, against a stand-in ralphex: describe the work,
 * answer the interview's question, read the plan it drafts, and take it —
 * which is what makes it write the file, and what earns the worktree.
 *
 * The interview never leaves on its own. It writes the plan and then offers to
 * work it in the checkout it was started from, so taking the plan is the only
 * thing that ends one.
 */

/** The open question, if there is one: the card the browser would be showing. */
function questionIn(sprout: SproutSession) {
  const closed = new Set(
    sprout.session.events.filter((e) => e.type === 'question_closed').map((e) => String(e.data.requestId)),
  );
  return sprout.session.events.find((e) => e.type === 'question' && !closed.has(String(e.data.requestId)));
}

/** Answer whatever it is asking, once it asks. */
async function answer(sprout: SproutSession, value: string): Promise<void> {
  await until(`a question (to answer "${value}")`, () => Boolean(questionIn(sprout)));
  sprout.session.answer(String(questionIn(sprout)!.data.requestId), value);
  // Let the answer land before the next `until` reads the same card again.
  await until('the card to close', () => !questionIn(sprout));
}

/** The plan on the table, as the browser would have it. */
function planOn(sprout: SproutSession) {
  return sprout.session.events.filter((e) => e.type === 'plan').at(-1);
}

async function untilDrafted(sprout: SproutSession): Promise<void> {
  await until('the plan to be drafted', () => Boolean(planOn(sprout)) && sprout.session.isReviewingDraft);
}

/** Take the plan the way the button does: accept the draft, then pot. */
async function sproutIt(sprout: SproutSession) {
  await until('a plan to take', () => sprout.hasPlan);
  const first = await sprout.take();
  if (first) return first;
  // The plan was a draft, so taking it set ralphex writing the file.
  await until('the plan file to be written', () => sprout.ready);
  return (await sprout.take())!;
}

/**
 * Stop the interview when the test is over. The real one never leaves on its
 * own — it waits at an offer to work the plan in the checkout it was started
 * from — so a test that ends without potting would leave the process behind.
 */
function stopAfter(t: TestContext, sprout: SproutSession): SproutSession {
  t.after(() => sprout.session.close());
  return sprout;
}

test('the interview grows a worktree, a branch and a first commit', async (t) => {
  const { parentDir, repo, repoPath, config } = makeTerrarium();
  const sprout = stopAfter(t, new SproutSession(config, repo, repoPath, 'somewhere to check the service is alive'));
  sprout.start();

  await until('the interview to ask something', () => Boolean(questionIn(sprout)));
  const asked = questionIn(sprout)!;
  assert.equal((asked.data.questions as Array<{ question: string }>)[0].question, 'what should this change be called?');
  // The escape hatch is not offered as a choice: the card has a box for that.
  assert.deepEqual(
    (asked.data.questions as Array<{ options: Array<{ label: string }> }>)[0].options.map((o) => o.label),
    ['health check', 'status endpoint'],
  );

  await answer(sprout, 'health check');

  // ralphex shows the plan as a draft before it writes anything, and asks what
  // to do with it. The plan reaches the glass; the picker does not.
  await untilDrafted(sprout);
  const put = planOn(sprout)!;
  assert.equal(put.data.title, 'health check');
  assert.deepEqual(put.data.progress, {
    checkboxes: { done: 0, total: 3 },
    tasks: { done: 0, total: 2 },
    percent: 0,
    complete: false,
  });
  // Nothing about the shape ralphex's own interview writes is a problem.
  assert.deepEqual(put.data.problems, []);
  assert.equal(questionIn(sprout), undefined, 'the draft review is never drawn as a question');

  // And it is a document, not scrollback: there is a markdown file to open from
  // the moment the plan is on the table, even though it has not been written
  // into the repo yet.
  const onTable = String(put.data.path);
  assert.ok(onTable.endsWith('.md'), `expected a markdown file, got ${onTable}`);
  assert.ok(existsSync(onTable), `expected the plan to have been written to ${onTable}`);
  assert.equal(parsePlan(readFileSync(onTable, 'utf8')).title, 'health check');

  const grown = await sproutIt(sprout);
  assert.equal(grown.branch, 'health-check');
  assert.equal(grown.worktreePath, join(parentDir, 'worktrees', repo, 'health-check'));
  assert.equal(grown.planPath, 'docs/plans/health-check.md');
  assert.ok(existsSync(grown.worktreePath));
  assert.equal(sprout.session.live, false, 'taking the plan winds the interview up');

  // The plan is on the branch, not loose in the developer's checkout.
  const onBranch = readFileSync(join(grown.worktreePath, grown.planPath), 'utf8');
  assert.equal(parsePlan(onBranch).title, 'health check');
  assert.ok(!existsSync(join(repoPath, grown.planPath)), 'the plan should not be left in the main checkout');
  assert.match(git(grown.worktreePath, 'log', '-1', '--format=%s'), /Add plan: health-check/);
  assert.equal(git(grown.worktreePath, 'status', '--porcelain').trim(), '');

  // And the checkout it came from is exactly as it was found.
  assert.equal(git(repoPath, 'status', '--porcelain').trim(), '');
  assert.equal(git(repoPath, 'branch', '--show-current').trim(), 'main');

  // Sprouting twice is one seedling: the button can be clicked twice.
  assert.deepEqual(await sprout.take(), grown);
});

test('answering in your own words is relayed the way a terminal would take it', async (t) => {
  const { repo, repoPath, config } = makeTerrarium();
  const sprout = stopAfter(t, new SproutSession(config, repo, repoPath, 'a thing'));
  sprout.start();

  await answer(sprout, 'Readiness Probe');
  const grown = await sproutIt(sprout);
  assert.equal(grown.branch, 'readiness-probe');
});

/**
 * The other way on. ralphex's own picker calls it "Revise" and then reads the
 * words off the next line; here it is a box and a button, and neither the
 * picker nor the word ever reaches the glass.
 */
test('saying what is wrong with the plan sends it back for another pass', async (t) => {
  const { repo, repoPath, config } = makeTerrarium();
  const sprout = stopAfter(t, new SproutSession(config, repo, repoPath, 'a thing'));
  sprout.start();
  await answer(sprout, 'health check');
  await untilDrafted(sprout);
  const first = String(planOn(sprout)!.data.markdown);

  sprout.session.say('keep it to one task');
  await until('a revised plan', () => String(planOn(sprout)!.data.markdown) !== first);
  const revised = String(planOn(sprout)!.data.markdown);
  assert.match(revised, /Revised: keep it to one task/);
  assert.equal(questionIn(sprout), undefined, 'still no picker on the glass');

  // And the plan that gets committed is the revised one.
  const grown = await sproutIt(sprout);
  assert.match(readFileSync(join(grown.worktreePath, grown.planPath), 'utf8'), /Revised: keep it to one task/);
});

test('composting an abandoned sprout takes the worktree, the branch and the plan', async (t) => {
  const { repo, repoPath, config } = makeTerrarium();
  const sprout = stopAfter(t, new SproutSession(config, repo, repoPath, 'a thing'));
  sprout.start();
  await answer(sprout, 'health check');
  const grown = await sproutIt(sprout);

  const { removed, failed } = await sprout.compost();
  assert.deepEqual(failed, []);
  assert.deepEqual(removed, [grown.worktreePath]);
  assert.ok(!existsSync(grown.worktreePath));
  assert.ok(!git(repoPath, 'branch', '--list', 'health-check').trim());
});

test('a plan written outside the plans folder is still found, once, unambiguously', async (t) => {
  const { repo, repoPath, config } = makeTerrarium();
  // Point the stand-in at a directory the plan scan does not look in, so the
  // one new markdown file in the repo is all there is to go on.
  const sprout = stopAfter(t, new SproutSession(config, repo, repoPath, 'a thing'));
  process.env.FAKE_RALPHEX_PLANS_DIR = 'notes';
  try {
    sprout.start();
    await answer(sprout, 'health check');
    await untilDrafted(sprout);
    // Nothing lands in the plans directory, so `ready` never fires: the file is
    // found by the fallback the first time the seedling is taken.
    sprout.session.acceptDraft();
    await until('the plan file to be written', () => existsSync(join(repoPath, 'notes', 'health-check.md')));
    const grown = await sprout.pot();
    assert.equal(grown.planPath, 'notes/health-check.md');
  } finally {
    delete process.env.FAKE_RALPHEX_PLANS_DIR;
  }
  await sprout.compost();
});

test('the progress log’s stamped copies are marked as machinery, and kept out of the flow', async (t) => {
  const { repo, repoPath, config } = makeTerrarium();
  const sprout = stopAfter(t, new SproutSession(config, repo, repoPath, 'a thing'));
  sprout.start();
  await answer(sprout, 'health check');
  await sproutIt(sprout);

  const lines = sprout.session.events.filter((e) => e.type === 'line');
  const stamped = lines.filter((e) => /^\[\d\d-\d\d-\d\d /.test(String(e.data.text)));
  assert.ok(stamped.length >= 2, 'the stand-in prints the progress log’s copies');
  assert.ok(
    stamped.every((e) => e.data.noise === true),
    'every stamped copy is machinery',
  );
  assert.ok(
    lines.some((e) => e.data.noise !== true),
    'and what it actually said is not',
  );
});

test('sprouting before there is a plan leaves the interview alone', async (t) => {
  const { repo, repoPath, config } = makeTerrarium();
  const sprout = stopAfter(t, new SproutSession(config, repo, repoPath, 'a thing'));
  sprout.start();
  await until('the first question', () => Boolean(questionIn(sprout)));

  await assert.rejects(() => sprout.take(), /not written a plan/);
  assert.equal(sprout.session.live, true, 'the interview carries on');

  await answer(sprout, 'health check');
  const grown = await sproutIt(sprout);
  assert.equal(grown.branch, 'health-check');
});

/**
 * The interview leaving without writing the plan out.
 *
 * Writing the file is the one part ralphex hands to a model, and a model can
 * end without doing it: ralphex then finds no plan of its own, prints the
 * elapsed time and exits cleanly, taking the approved plan with it. It is the
 * document that was on the screen when the developer took it, so it is written
 * here instead and the seedling grows on it as usual.
 */
test('a plan the interview never writes out is kept, and grown from anyway', async (t) => {
  const { repo, repoPath, config } = makeTerrarium();
  const sprout = stopAfter(t, new SproutSession(config, repo, repoPath, 'a thing'));
  process.env.FAKE_RALPHEX_NO_WRITE = '1';
  try {
    sprout.start();
    await answer(sprout, 'health check');
    await untilDrafted(sprout);

    assert.equal(await sprout.take(), null, 'taking a draft comes back with nothing to pot');
    await until('the interview to leave', () => !sprout.session.live);

    const grown = (await sprout.take())!;
    assert.equal(grown.planPath, `docs/plans/${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-health-check.md`);
    // The stamp orders the plans folder and stops there: the branch and the
    // worktree beside it are called what the work is called.
    assert.equal(grown.branch, 'health-check');
    assert.equal(parsePlan(readFileSync(join(grown.worktreePath, grown.planPath), 'utf8')).title, 'health check');
    assert.match(git(grown.worktreePath, 'log', '-1', '--format=%s'), /^Add plan: /);
    // The checkout the interview ran in is left exactly as it was found.
    assert.equal(git(repoPath, 'status', '--porcelain').trim(), '');
  } finally {
    delete process.env.FAKE_RALPHEX_NO_WRITE;
  }
  await sprout.compost();
});

/** A draft nobody took is not a plan: nothing is written and nothing is grown. */
test('a draft left untaken is never written out on the interview’s way out', async (t) => {
  const { repo, repoPath, config } = makeTerrarium();
  const sprout = stopAfter(t, new SproutSession(config, repo, repoPath, 'a thing'));
  process.env.FAKE_RALPHEX_NO_WRITE = '1';
  try {
    sprout.start();
    await answer(sprout, 'health check');
    await untilDrafted(sprout);
    sprout.session.cancel();
    await until('the interview to leave', () => !sprout.session.live);
    await assert.rejects(() => sprout.pot(), /without writing a plan/);
    assert.deepEqual(listPlanFiles(repoPath, config.plansDir), []);
  } finally {
    delete process.env.FAKE_RALPHEX_NO_WRITE;
  }
});
