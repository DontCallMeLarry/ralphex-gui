import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { listWorktrees } from './git.ts';
import type { RepoInfo } from './types.ts';

/**
 * Scan the parent folder for git repositories (FR-1).
 *
 * Only direct children are considered. A child whose `.git` is a *file* is a
 * linked worktree of some other repo and is not itself a repository — its
 * specimens are found via the main repo's `git worktree list`.
 */
export async function discoverRepos(
  parentDir: string,
  excludeRepos: string[],
  excludeWorktreePatterns: string[] = [],
): Promise<RepoInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(parentDir);
  } catch (err) {
    throw new Error(`Cannot read parent folder ${parentDir}: ${(err as Error).message}`);
  }

  const excluded = new Set(excludeRepos);
  const repos: RepoInfo[] = [];

  for (const name of entries.sort()) {
    if (name.startsWith('.') || excluded.has(name)) continue;
    const repoPath = join(parentDir, name);
    let gitEntry;
    try {
      const dirStat = await stat(repoPath);
      if (!dirStat.isDirectory()) continue;
      gitEntry = await stat(join(repoPath, '.git'));
    } catch {
      continue; // not a repo (or unreadable .git) — skip silently
    }
    if (!gitEntry.isDirectory()) continue; // .git file => linked worktree, not a repo

    try {
      const worktrees = (await listWorktrees(repoPath)).filter(
        (wt) => wt.isMain || !isExcludedWorktree(wt.path, excludeWorktreePatterns),
      );
      repos.push({ name, path: repoPath, worktrees, error: null });
    } catch (err) {
      // Graceful degradation (NFR-4): a broken repo never blocks the rest.
      repos.push({ name, path: repoPath, worktrees: [], error: (err as Error).message });
    }
  }

  return repos;
}

/**
 * Worktrees Terrarium deliberately ignores: tool-internal ones and scratch
 * checkouts under a temp dir. They are not work being shepherded to production,
 * so they are noise in the glass.
 */
export function isExcludedWorktree(path: string, patterns: string[]): boolean {
  return patterns.some((p) => path.includes(p));
}

/** Worktree paths that currently exist on disk, per repo (used to diff sprout sessions). */
export function linkedWorktreePaths(repos: RepoInfo[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const repo of repos) {
    const set = new Set<string>();
    for (const wt of repo.worktrees) {
      if (!wt.isMain && existsSync(wt.path)) set.add(wt.path);
    }
    map.set(repo.name, set);
  }
  return map;
}
