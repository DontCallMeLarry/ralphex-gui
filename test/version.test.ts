import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appVersion } from '../server/version.ts';
import { git } from './helpers.ts';

function checkout(commits: number, version: string | null = '2.3.0'): string {
  const dir = mkdtempSync(join(tmpdir(), 'terrarium-version-'));
  if (version) writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'terrarium', version }));
  git(dir, 'init', '-q', '-b', 'main');
  for (let i = 0; i < commits; i++) {
    writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `commit ${i}`);
  }
  return dir;
}

test('the patch number is the commit count, so a push moves it on its own', () => {
  assert.equal(appVersion(checkout(3)).label, 'v2.3.3');
  assert.equal(appVersion(checkout(4)).label, 'v2.3.4');
});

test('the answer is read once, so the line cannot drift mid-session', () => {
  const dir = checkout(1);
  const first = appVersion(dir);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'pushed elsewhere');
  assert.equal(appVersion(dir).label, first.label);
});

test('the line says when the code last moved, and which commit it is', () => {
  const version = appVersion(checkout(1));
  assert.equal(typeof version.commit, 'string');
  assert.ok(Date.parse(version.updatedAt!) > 0);
});

test('outside a checkout there is still a version to show', () => {
  const dir = mkdtempSync(join(tmpdir(), 'terrarium-nogit-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.4.0' }));
  const version = appVersion(dir);
  assert.equal(version.label, 'v1.4.0');
  assert.equal(version.updatedAt, null);
  assert.equal(version.commit, null);
});

test('a copy with no readable package.json still says something', () => {
  assert.equal(appVersion(checkout(2, null)).label, 'v0.0.2');
});
