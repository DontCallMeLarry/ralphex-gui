import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findPlan, listPlanFiles, resolvePlanPath } from '../server/ralphex/plans.ts';

const PLAN = (title: string) =>
  ['# Plan: ' + title, '', '## Overview', 'why', '', '## Validation Commands', '- `npm test`', '', '### Task 1: do it', '- [ ] work', ''].join('\n');

function worktree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'plans-'));
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

test('plan files are found under the plans folder, nested folders included', () => {
  const dir = worktree({
    'docs/plans/a.md': PLAN('a'),
    'docs/plans/completed/b.md': PLAN('b'),
    'docs/plans/notes.txt': 'not a plan',
    'src/thing.md': PLAN('elsewhere'),
  });
  const found = listPlanFiles(dir, 'docs/plans').map((f) => f.slice(dir.length + 1));
  assert.deepEqual(found, ['docs/plans/a.md', 'docs/plans/completed/b.md']);
});

test('a missing plans folder is empty, not an error', () => {
  assert.deepEqual(listPlanFiles(worktree({}), 'docs/plans'), []);
});

test('the branch names its own plan', () => {
  const dir = worktree({ 'docs/plans/other.md': PLAN('other'), 'docs/plans/health-check.md': PLAN('health check') });
  const doc = findPlan(dir, 'docs/plans', 'health-check');
  assert.equal(doc.file, 'docs/plans/health-check.md');
  assert.equal(doc.analysis?.title, 'health check');
});

/**
 * ralphex stamps the date on the front of a plan filename to keep the folder in
 * order. The branch it grows on does not carry it, so the two are matched with
 * the stamp taken off both.
 */
test('a dated plan file is the plan for the undated branch', () => {
  const dir = worktree({
    'docs/plans/20260824-health-check.md': PLAN('health check'),
    'docs/plans/other.md': PLAN('other'),
  });
  assert.equal(findPlan(dir, 'docs/plans', 'health-check').analysis?.title, 'health check');
  assert.equal(findPlan(dir, 'docs/plans', '2026-08-24-health-check').analysis?.title, 'health check');
});

test('the recorded path wins, because that is the file the sprout committed', () => {
  const dir = worktree({ 'docs/plans/health-check.md': PLAN('branch named'), 'docs/plans/kept.md': PLAN('recorded') });
  const doc = findPlan(dir, 'docs/plans', 'health-check', 'docs/plans/kept.md');
  assert.equal(doc.analysis?.title, 'recorded');
});

test('with nothing to go on, the plan touched last wins', () => {
  const dir = worktree({ 'docs/plans/old.md': PLAN('old'), 'docs/plans/new.md': PLAN('new') });
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(dir, 'docs/plans/old.md'), old, old);
  assert.equal(findPlan(dir, 'docs/plans', 'unrelated').analysis?.title, 'new');
});

test('markdown that is not a plan is not mistaken for one', () => {
  const dir = worktree({ 'docs/plans/readme.md': 'just some notes\n' });
  assert.equal(findPlan(dir, 'docs/plans', 'anything').file, null);
});

test('a worktree that is gone has no plan, and does not throw looking', () => {
  const doc = findPlan('/definitely/not/here', 'docs/plans', 'x');
  assert.equal(doc.file, null);
  assert.equal(doc.analysis, null);
});

test('a plan path is resolved inside the plans folder or not at all', () => {
  const dir = worktree({ 'docs/plans/a.md': PLAN('a') });
  assert.equal(resolvePlanPath(dir, 'docs/plans', 'a.md'), join(dir, 'docs/plans/a.md'));
  assert.equal(resolvePlanPath(dir, 'docs/plans', 'docs/plans/a.md'), join(dir, 'docs/plans/a.md'));
  assert.equal(resolvePlanPath(dir, 'docs/plans', '../../../etc/passwd.md'), null);
  assert.equal(resolvePlanPath(dir, 'docs/plans', '/etc/passwd.md'), null);
  assert.equal(resolvePlanPath(dir, 'docs/plans', 'a.txt'), null);
  assert.equal(resolvePlanPath(dir, 'docs/plans', ''), null);
});
