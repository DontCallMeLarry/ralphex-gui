import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TerrariumConfig } from '../server/config.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The stand-in binary Terrarium drives instead of the real ralphex. */
export const FAKE_RALPHEX = join(HERE, 'fixtures', 'fake-ralphex.mjs');

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@localhost',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@localhost',
    },
  });
}

/**
 * A parent folder with one repo in it, laid out the way Terrarium expects to
 * find things: repos as direct children, worktrees in a sibling folder.
 */
export function makeTerrarium(): { parentDir: string; repo: string; repoPath: string; config: TerrariumConfig } {
  const parentDir = mkdtempSync(join(tmpdir(), 'terrarium-'));
  const repo = 'widget';
  const repoPath = join(parentDir, repo);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init', '-q', '-b', 'main');
  writeFileSync(join(repoPath, 'README.md'), '# widget\n');
  git(repoPath, 'add', '-A');
  git(repoPath, 'commit', '-q', '-m', 'root');

  const config: TerrariumConfig = {
    parentDir,
    excludeRepos: [],
    excludeWorktreePatterns: ['/.ralphex/worktrees/', '/tmp-scratch/'],
    port: 0,
    autoSync: false,
    autoSyncMinutes: 2,
    updateCheckHours: 0,
    stateFile: join(parentDir, 'state.json'),
    sproutEnabled: true,
    ralphexCommand: FAKE_RALPHEX,
    plansDir: 'docs/plans',
    planModel: 'haiku',
    taskModel: 'haiku',
    reviewModel: 'haiku',
    codeCommand: null,
    appRoot: resolve(HERE, '..'),
  };
  return { parentDir, repo, repoPath, config };
}

/** Wait for something to become true, or give up with a readable failure. */
export async function until(what: string, predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
