import { basename } from 'node:path';
import {
  branchExists,
  changedPaths,
  divergence,
  dirtyPaths,
  fastForward,
  fetchOrigin,
  getDefaultBranch,
  hasOrigin,
  lastFetchAt,
  listWorktrees,
  mergeBase,
  moveBranchTo,
} from './git.ts';
import type { RepoInfo, RepoSync } from './types.ts';

/**
 * Keep each repo's default branch level with origin, so new worktrees always
 * branch from current code.
 *
 * The only mutation is a strict fast-forward: fetch, then move `main` up to
 * `origin/main` when — and only when — no local commits would be rewritten. A
 * branch that has diverged is left exactly as it is and reported instead. A
 * dirty checkout only blocks the fast-forward when the dirt overlaps the
 * incoming commits; dirt elsewhere in the tree doesn't stop it. Nothing here
 * rebases, merges, resets, or touches a feature branch.
 */
export class Freshener {
  #inflight = new Map<string, Promise<RepoSync>>();
  #last = new Map<string, RepoSync>();

  /** The most recent result for a repo, for headers rendered without a sync pass. */
  last(repo: string): RepoSync | null {
    return this.#last.get(repo) ?? null;
  }

  /**
   * Sync one repo. Concurrent calls for the same repo share a single pass — two
   * overlapping fetches of the same remote would be worse than one caller
   * getting a slightly-less-forceful result.
   */
  sync(repo: RepoInfo, opts: { force?: boolean; maxAgeMs?: number } = {}): Promise<RepoSync> {
    const running = this.#inflight.get(repo.name);
    if (running) return running;
    const pass = this.#run(repo, opts)
      .then((result) => {
        // Always keep the newest. Every pass recomputes ahead/behind from local
        // refs, so a throttled pass that skipped the fetch is still as current
        // as the last fetch was. Holding on to an older result would only mean
        // a problem the developer already fixed by hand stays on screen.
        this.#last.set(repo.name, result);
        return result;
      })
      .finally(() => this.#inflight.delete(repo.name));
    this.#inflight.set(repo.name, pass);
    return pass;
  }

  syncAll(repos: RepoInfo[], opts: { force?: boolean; maxAgeMs?: number } = {}): Promise<RepoSync[]> {
    return Promise.all(repos.map((repo) => this.sync(repo, opts)));
  }

  async #run(repo: RepoInfo, opts: { force?: boolean; maxAgeMs?: number }): Promise<RepoSync> {
    const result: RepoSync = {
      repo: repo.name,
      defaultBranch: null,
      fetched: false,
      advancedBy: 0,
      problem: null,
      detail: null,
      at: new Date().toISOString(),
    };
    // A repo that failed to scan already says so in its own error chip.
    if (repo.error !== null || !repo.path) return result;
    if (!(await hasOrigin(repo.path))) return result; // nothing upstream to track

    // FETCH_HEAD's age, not an in-memory timer: a fetch you ran in a terminal
    // counts, and the throttle survives a restart.
    const previous = await lastFetchAt(repo.path);
    const stale =
      previous === null || Date.now() - Date.parse(previous) >= (opts.maxAgeMs ?? 0);
    if (opts.force || stale) {
      try {
        await fetchOrigin(repo.path);
        result.fetched = true;
      } catch (err) {
        return {
          ...result,
          problem: 'origin unreachable',
          detail: `Could not fetch from origin, so the counts below come from whatever was last fetched${
            previous ? ` (${previous})` : ''
          }.\n\n${firstLine(err)}`,
        };
      }
    }

    const branch = await getDefaultBranch(repo.path);
    result.defaultBranch = branch;
    // No origin default branch and no local copy of it: nothing to keep current.
    if (!branch || !(await branchExists(repo.path, branch))) return result;

    const compare = await divergence(repo.path, `refs/heads/${branch}`, `refs/remotes/origin/${branch}`);
    if (!compare) return result;
    const { ahead, behind } = compare;

    if (ahead > 0 && behind === 0) {
      return {
        ...result,
        problem: `${branch} has ${ahead} local commit${ahead === 1 ? '' : 's'}`,
        detail: `Local ${branch} carries ${ahead} commit${
          ahead === 1 ? '' : 's'
        } that origin doesn't have. It still contains everything origin/${branch} does, so new worktrees are fine — but committing to ${branch} locally is worth a look.`,
      };
    }
    if (ahead > 0) {
      // Two branches with no common ancestor aren't a divergence that drifted
      // apart — they grew from different roots, and the advice differs enough
      // to be worth its own chip.
      const shared = await mergeBase(repo.path, `refs/heads/${branch}`, `refs/remotes/origin/${branch}`);
      return {
        ...result,
        problem: shared ? `${branch} has diverged` : `${branch} shares no history with origin`,
        detail: shared
          ? `Local ${branch} is ${ahead} commit${ahead === 1 ? '' : 's'} ahead and ${behind} behind origin/${branch}. Fast-forwarding it would rewrite local commits, so Terrarium left it alone — open this chip to sort it out.`
          : `Local ${branch} and origin/${branch} have no commit in common: ${ahead} local commit${
              ahead === 1 ? '' : 's'
            } against ${behind} on origin. Usually the remote was created separately (an "Initial commit" nobody pulled). Open this chip to see both sides and pick a resolution.`,
      };
    }
    if (behind === 0) return result; // already level with origin

    const holder = (await listWorktrees(repo.path)).find((wt) => wt.branch === branch && wt.exists);
    try {
      if (!holder) {
        await moveBranchTo(repo.path, branch, `refs/remotes/origin/${branch}`);
      } else {
        const dirty = await dirtyPaths(holder.path);
        let overlap: string[] = [];
        if (dirty.length > 0) {
          const changed = new Set(
            await changedPaths(repo.path, `refs/heads/${branch}`, `refs/remotes/origin/${branch}`),
          );
          overlap = dirty.filter((p) => changed.has(p));
        }
        if (overlap.length > 0) {
          return {
            ...result,
            problem: `${branch} is ${behind} behind — dirty checkout`,
            detail: `Fast-forwarding ${branch} would overwrite ${overlap.length} uncommitted file${
              overlap.length === 1 ? '' : 's'
            } in ${basename(holder.path)} (${overlap.slice(0, 3).join(', ')}${
              overlap.length > 3 ? ', …' : ''
            }). Commit or stash there and refresh.`,
          };
        }
        await fastForward(holder.path, `origin/${branch}`);
      }
    } catch (err) {
      return {
        ...result,
        problem: `${branch} is ${behind} behind`,
        detail: `Could not fast-forward ${branch} to origin/${branch}.\n\n${firstLine(err)}`,
      };
    }

    return { ...result, advancedBy: behind };
  }
}

export function firstLine(err: unknown): string {
  const message = (err as Error).message ?? String(err);
  return (
    message
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/^Command failed:/.test(l))[0] ?? message.trim()
  );
}
