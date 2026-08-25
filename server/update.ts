import { execFile } from 'node:child_process';
import { delimiter, dirname } from 'node:path';
import { promisify } from 'node:util';
import { commitLines, divergence, fastForward, fetchOrigin, git, hasOrigin, isDirty, lastFetchAt } from './git.ts';
import { firstLine } from './freshen.ts';
import type { CommitLine } from './types.ts';

const execFileAsync = promisify(execFile);

/**
 * The exit code that means "boot me again". The keeper (`server/main.ts`) sees
 * it and starts a fresh server process, which comes up on the just-pulled code.
 * Every other exit — a crash, a Ctrl-C — passes through the keeper untouched.
 */
export const RESTART_EXIT_CODE = 87;

/** How the dashboard's own clone compares with its origin. */
export interface UpdateStatus {
  /**
   * `ready` — origin is ahead and a fast-forward would take it cleanly.
   * `blocked` — an update may exist but applying it is not Terrarium's call
   * (local commits, a dirty tree, no origin at all).
   */
  state: 'current' | 'ready' | 'blocked' | 'error';
  /** Commits origin has that this copy doesn't. */
  behind: number;
  /** What the update contains, newest first (capped at 25). */
  commits: CommitLine[];
  /** Why nothing can happen automatically — phrased to follow "…, but". */
  reason: string | null;
  checkedAt: string | null;
  applying: boolean;
}

/**
 * Terrarium is a clone that people run, so it keeps itself current the same
 * way it keeps the repos current: fetch origin on a cadence (the fetch *is*
 * the download), report honestly, and change nothing until a human presses
 * the button. Applying is the same strict fast-forward the repo sync uses —
 * a copy with local commits or uncommitted changes is never rewritten.
 */
export class Updater {
  #appRoot: string;
  #status: UpdateStatus = emptyStatus();
  #inflight: Promise<UpdateStatus> | null = null;
  #applying = false;

  constructor(appRoot: string) {
    this.#appRoot = appRoot;
  }

  /** The last check's answer — cheap, no network. The UI polls this. */
  status(): UpdateStatus {
    return { ...this.#status, applying: this.#applying };
  }

  /** Check again every `hours`, forever. The timer never keeps the process alive. */
  schedule(hours: number): void {
    if (hours <= 0) return;
    setInterval(() => void this.check(), hours * 3_600_000).unref();
  }

  /** Concurrent checks share one pass, same as the repo freshener. */
  check(opts: { maxAgeMs?: number } = {}): Promise<UpdateStatus> {
    if (this.#inflight) return this.#inflight;
    this.#inflight = this.#check(opts)
      .catch(
        (err): UpdateStatus => ({
          ...emptyStatus(),
          state: 'error',
          reason: firstLine(err),
          checkedAt: new Date().toISOString(),
        }),
      )
      .then((status) => {
        this.#status = status;
        return this.status();
      })
      .finally(() => {
        this.#inflight = null;
      });
    return this.#inflight;
  }

  async #check(opts: { maxAgeMs?: number }): Promise<UpdateStatus> {
    const base: UpdateStatus = { ...emptyStatus(), checkedAt: new Date().toISOString() };
    if (!(await hasOrigin(this.#appRoot))) {
      return { ...base, state: 'blocked', reason: 'this copy has no origin remote to update from' };
    }
    const branch = await this.#branch();
    if (!branch) {
      return { ...base, state: 'blocked', reason: 'this copy is not on a branch (detached HEAD)' };
    }

    // Same throttle as the repo freshener: FETCH_HEAD's age, so a fetch from a
    // terminal counts and a restart right after a repot doesn't refetch. A
    // failed fetch is not news — the counts below still hold as of the last
    // fetch that worked, and the next scheduled pass will try again.
    const previous = await lastFetchAt(this.#appRoot);
    const stale = previous === null || Date.now() - Date.parse(previous) >= (opts.maxAgeMs ?? 0);
    if (stale) await fetchOrigin(this.#appRoot).catch(() => {});

    const compare = await divergence(this.#appRoot, `refs/heads/${branch}`, `refs/remotes/origin/${branch}`);
    if (!compare) return { ...base, state: 'blocked', reason: `origin has no ${branch} branch to compare against` };
    const { ahead, behind } = compare;
    if (behind === 0) return base; // current — an ahead-only copy is someone developing Terrarium, not the updater's business

    const commits = await commitLines(this.#appRoot, `${branch}..origin/${branch}`);
    if (ahead > 0) {
      return {
        ...base,
        state: 'blocked',
        behind,
        commits,
        reason: `this copy has ${ahead} local commit${ahead === 1 ? '' : 's'} — bring the update in by hand (git pull --rebase)`,
      };
    }
    if (await isDirty(this.#appRoot)) {
      return {
        ...base,
        state: 'blocked',
        behind,
        commits,
        reason: "there are uncommitted changes in the dashboard's own folder — commit or stash them first",
      };
    }
    return { ...base, state: 'ready', behind, commits };
  }

  /**
   * Pull the update and make the working copy runnable again. Steps are
   * proportionate to what actually changed: `npm install` only when the
   * lockfile moved, `npm run build` only when something that feeds the bundle
   * did. The restart itself is the caller's decision — routes know whether a
   * keeper is listening for the exit code.
   */
  async apply(): Promise<{ pulled: number; installed: boolean; rebuilt: boolean }> {
    if (this.#applying) throw new Error('An update is already being applied.');
    this.#applying = true;
    try {
      // Re-verify at press time: the banner may be hours old.
      const status = await this.check({ maxAgeMs: 60_000 });
      if (status.state !== 'ready') {
        throw new Error(
          status.state === 'current'
            ? 'Already up to date — nothing to repot.'
            : `The update cannot be applied: ${status.reason ?? 'unknown reason'}.`,
        );
      }
      const branch = (await this.#branch())!;
      const before = (await git(this.#appRoot, ['rev-parse', 'HEAD'])).trim();
      await fastForward(this.#appRoot, `origin/${branch}`);

      const changed = (await git(this.#appRoot, ['diff', '--name-only', `${before}..HEAD`]))
        .split('\n')
        .filter(Boolean);
      const installed = changed.some((f) => f === 'package.json' || f === 'package-lock.json');
      const rebuilt =
        installed || changed.some((f) => f.startsWith('web/') || f === 'vite.config.ts' || f === 'tsconfig.json');
      // A failure past this point leaves new files with old dependencies — say
      // exactly what to run by hand rather than pretending nothing happened.
      try {
        if (installed) await this.#npm(['install', '--no-audit', '--no-fund'], 300_000);
        if (rebuilt) await this.#npm(['run', 'build'], 300_000);
      } catch (err) {
        throw new Error(
          `The update was pulled, but finishing it failed: ${firstLine(err)}. ` +
            `Run \`npm install && npm run build\` in ${this.#appRoot}, then restart Terrarium.`,
        );
      }
      this.#status = { ...emptyStatus(), checkedAt: new Date().toISOString() };
      return { pulled: status.behind, installed, rebuilt };
    } finally {
      this.#applying = false;
    }
  }

  async #branch(): Promise<string | null> {
    try {
      return (await git(this.#appRoot, ['symbolic-ref', '--short', 'HEAD'])).trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Under the background agent there is no shell PATH to speak of, but the
   * node running this process knows where it lives — and npm lives next to it.
   */
  async #npm(args: string[], timeoutMs: number): Promise<void> {
    await execFileAsync('npm', args, {
      cwd: this.#appRoot,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` },
    });
  }
}

function emptyStatus(): UpdateStatus {
  return { state: 'current', behind: 0, commits: [], reason: null, checkedAt: null, applying: false };
}
