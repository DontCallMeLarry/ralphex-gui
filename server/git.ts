import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { BackupRef, CommitLine, WorktreeInfo } from './types.ts';

const execFileAsync = promisify(execFile);

/** Run a git command in `cwd`. Read-only unless used by the sync or prune flows. */
export async function git(
  cwd: string,
  args: string[],
  timeoutMs = 15_000,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
  });
  return stdout;
}

/** Parse `git worktree list --porcelain` output. The first entry is the main worktree. */
export function parseWorktreePorcelain(output: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> | null = null;

  const flush = () => {
    if (current?.path) {
      worktrees.push({
        path: current.path,
        head: current.head ?? '',
        branch: current.branch ?? null,
        isMain: worktrees.length === 0,
        bare: current.bare ?? false,
        locked: current.locked ?? false,
        prunable: current.prunable ?? false,
        exists: existsSync(current.path),
      });
    }
    current = null;
  };

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      current = { path: line.slice('worktree '.length) };
    } else if (!current) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.branch = null;
    } else if (line.startsWith('locked')) {
      current.locked = true;
    } else if (line.startsWith('prunable')) {
      current.prunable = true;
    }
    // Unknown attributes are tolerated on purpose.
  }
  flush();
  return worktrees;
}

export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  return parseWorktreePorcelain(await git(repoPath, ['worktree', 'list', '--porcelain']));
}

/**
 * Stage everything in a worktree.
 *
 * A run's deliverable is a diff somebody has to read, and reading a diff
 * happens in an editor, not here — so whatever a run leaves uncommitted is
 * staged the moment it stops and again whenever the worktree is opened. VS
 * Code's source control puts staged work at the top with the diff one click
 * away, which turns "some files changed" into something you can actually
 * review.
 *
 * This is the one git write that touches a specimen's index, and it is the
 * mildest one there is: nothing is committed, nothing is pushed, .gitignore is
 * still obeyed, and `git reset` puts it back. False when git refused —
 * the caller says what is actually staged rather than what it hoped for.
 */
export async function stageAll(worktreePath: string): Promise<boolean> {
  if (!existsSync(worktreePath)) return false;
  try {
    await git(worktreePath, ['add', '-A'], 30_000);
    return true;
  } catch {
    return false;
  }
}

/** Uncommitted changes in a worktree (staged, unstaged, or untracked). */
export async function isDirty(worktreePath: string): Promise<boolean> {
  const out = await git(worktreePath, ['status', '--porcelain']);
  return out.trim().length > 0;
}

/**
 * Repo-relative paths with uncommitted changes. A rename line
 * (`R  old -> new`) contributes both sides — either one, if an incoming
 * commit also touches it, should block a fast-forward.
 */
export async function dirtyPaths(worktreePath: string): Promise<string[]> {
  const out = await git(worktreePath, ['status', '--porcelain']);
  const paths: string[] = [];
  for (const line of out.split('\n')) {
    if (line.length < 4) continue;
    const rest = line.slice(3);
    const arrow = rest.indexOf(' -> ');
    if (arrow === -1) paths.push(rest);
    else paths.push(rest.slice(0, arrow), rest.slice(arrow + 4));
  }
  return paths;
}

/**
 * Whether a folder is still a working git worktree. A directory can outlive its
 * registration — a temp worktree whose gitdir was cleaned up, for instance —
 * and every git command inside it then fails with "not a git repository".
 */
export async function isUsableWorktree(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    // Compare against the toplevel, not just "am I in a work tree" — a folder
    // nested inside another repo would otherwise answer for its parent.
    const top = (await git(path, ['rev-parse', '--show-toplevel'])).trim();
    return top.length > 0 && realpathSync(top) === realpathSync(path);
  } catch {
    return false;
  }
}

/** Local vs remote commit counts for the same branch. No network — local refs only. */
export async function divergence(
  repoPath: string,
  local: string,
  remote: string,
): Promise<{ ahead: number; behind: number } | null> {
  try {
    const out = await git(repoPath, ['rev-list', '--left-right', '--count', `${local}...${remote}`]);
    const [ahead, behind] = out.trim().split(/\s+/).map((n) => parseInt(n, 10));
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
    return { ahead, behind };
  } catch {
    return null; // one of the refs doesn't exist
  }
}

/** Paths touched between two refs, e.g. `origin/main..main`. */
export async function changedPaths(repoPath: string, from: string, to: string): Promise<string[]> {
  const out = await git(repoPath, ['diff', '--name-only', from, to]);
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * The commit two refs both descend from, or null when they share no history at
 * all. "Diverged" and "grew from different roots" look identical in a pair of
 * ahead/behind counts, but they call for different advice.
 */
export async function mergeBase(repoPath: string, a: string, b: string): Promise<string | null> {
  try {
    return (await git(repoPath, ['merge-base', a, b])).trim() || null;
  } catch {
    return null; // no common ancestor, or a ref that doesn't exist
  }
}

/**
 * Whether `ancestor`'s commit is contained in `descendant`'s history. A sha
 * the local clone has never fetched answers false — "can't prove it" and "no"
 * are the same non-evidence to every caller this has.
 */
export async function isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/** Commits in `range` (e.g. `origin/main..main`), newest first. */
export async function commitLines(repoPath: string, range: string, limit = 25): Promise<CommitLine[]> {
  try {
    const out = await git(repoPath, ['log', `--max-count=${limit}`, '--format=%h%x1f%s', range]);
    return out
      .split('\n')
      .filter((line) => line.includes('\x1f'))
      .map((line) => {
        const [sha, subject] = line.split('\x1f');
        return { sha, subject };
      });
  } catch {
    return [];
  }
}

/**
 * Park a branch's current tip under `refs/terrarium/backup/` before rewriting
 * it. A rebase or reset that a human triggered on purpose is still a rewrite —
 * this is the ref that makes it undoable with a single `git branch` command.
 */
export async function createBackupRef(repoPath: string, branch: string, stamp: number): Promise<string> {
  const ref = `refs/terrarium/backup/${branch}/${stamp}`;
  await git(repoPath, ['update-ref', ref, `refs/heads/${branch}`]);
  return ref;
}

/** Drop a ref — used to clean up a backup whose rewrite never happened. */
export async function deleteRef(repoPath: string, ref: string): Promise<void> {
  await git(repoPath, ['update-ref', '-d', ref]);
}

/**
 * Previous backups for a branch, newest first. `for-each-ref`'s format language
 * has no `%xNN` escape the way `git log`'s does, so the separator goes in as a
 * real byte.
 */
export async function listBackupRefs(repoPath: string, branch: string): Promise<BackupRef[]> {
  try {
    const out = await git(repoPath, [
      'for-each-ref',
      `--format=%(refname)\x1f%(objectname:short)\x1f%(contents:subject)`,
      `refs/terrarium/backup/${branch}`,
    ]);
    return out
      .split('\n')
      .filter((line) => line.includes('\x1f'))
      .map((line) => {
        const [ref, sha, subject] = line.split('\x1f');
        const stamp = Number(ref.slice(ref.lastIndexOf('/') + 1));
        return { ref, sha, subject, at: Number.isFinite(stamp) ? new Date(stamp).toISOString() : '' };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch {
    return [];
  }
}

/**
 * Replay the checked-out branch's own commits on top of `upstream`. A rebase
 * that stops on a conflict leaves the worktree mid-operation, which is no state
 * to hand back to a dashboard — so a failure is always unwound before it throws.
 */
export async function rebaseOnto(worktreePath: string, upstream: string): Promise<void> {
  try {
    await git(worktreePath, ['rebase', upstream], 180_000);
  } catch (err) {
    await git(worktreePath, ['rebase', '--abort']).catch(() => {});
    throw err;
  }
}

/** Move a checked-out branch (and its working copy) onto `target`. */
export async function resetHard(worktreePath: string, target: string): Promise<void> {
  await git(worktreePath, ['reset', '--hard', target], 60_000);
}

/** Check `branch` out at `path`. Git refuses if it is checked out elsewhere. */
export async function addWorktree(repoPath: string, path: string, branch: string): Promise<void> {
  await git(repoPath, ['worktree', 'add', '--quiet', path, branch], 180_000);
}

export async function hasOrigin(repoPath: string): Promise<boolean> {
  try {
    return (await git(repoPath, ['remote']))
      .split('\n')
      .map((r) => r.trim())
      .includes('origin');
  } catch {
    return false;
  }
}

/**
 * Update remote-tracking refs from origin. `--prune` drops refs for branches
 * that no longer exist upstream, which is what makes "commits on no remote"
 * mean anything. Batch-mode ssh so a missing credential fails instead of
 * blocking on a prompt no one can see.
 */
export async function fetchOrigin(repoPath: string): Promise<void> {
  await git(repoPath, ['fetch', '--prune', '--quiet', 'origin'], 90_000, {
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o ConnectTimeout=10',
  });
}

/**
 * What origin considers the default branch. `origin/HEAD` is authoritative but
 * isn't always set locally, so fall back to the conventional names before
 * giving up — a repo with no remote branches genuinely has no answer.
 */
export async function getDefaultBranch(repoPath: string): Promise<string | null> {
  try {
    const ref = await git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    return ref.trim().replace(/^origin\//, '');
  } catch {
    for (const name of ['main', 'master']) {
      try {
        await git(repoPath, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${name}`]);
        return name;
      } catch {
        // try the next convention
      }
    }
    return null;
  }
}

/**
 * Point a local branch at its remote-tracking ref. Only ever called after
 * confirming the move is a strict fast-forward; git itself refuses when the
 * branch is checked out somewhere, which is the guard that keeps a working
 * copy from being yanked out from under anyone.
 */
export async function moveBranchTo(repoPath: string, branch: string, target: string): Promise<void> {
  await git(repoPath, ['branch', '--force', branch, target]);
}

/** Advance a checked-out branch without ever creating a merge commit. */
export async function fastForward(worktreePath: string, target: string): Promise<void> {
  await git(worktreePath, ['merge', '--ff-only', target], 60_000);
}

/** When the repo last heard from its remote, via FETCH_HEAD's mtime. */
export async function lastFetchAt(repoPath: string): Promise<string | null> {
  try {
    const gitDir = (await git(repoPath, ['rev-parse', '--absolute-git-dir'])).trim();
    return statSync(join(gitDir, 'FETCH_HEAD')).mtime.toISOString();
  } catch {
    return null;
  }
}

/** Commits on `branch` that exist on no remote-tracking ref. */
export async function unpushedCount(repoPath: string, branch: string): Promise<number> {
  try {
    const out = await git(repoPath, ['rev-list', '--count', branch, '--not', '--remotes']);
    return parseInt(out.trim(), 10) || 0;
  } catch {
    return 0; // branch may be gone already
  }
}

/**
 * Push a branch to origin, tracking it.
 *
 * The one git write in the Terrarium that leaves the machine, and the only
 * thing that can turn a worktree into something other people can read. It is
 * never on the way to anything else: nothing calls this to tidy up, to sync or
 * to keep a branch warm — it runs when somebody presses the button that says
 * this is ready, and the merge request that follows is the whole reason.
 *
 * `GIT_TERMINAL_PROMPT=0` is already set for every git call here, so a push
 * that needs a credential fails saying so rather than hanging on a prompt
 * nobody can see.
 */
export async function pushBranch(worktreePath: string, branch: string): Promise<void> {
  await git(worktreePath, ['push', '--set-upstream', 'origin', branch], 120_000);
}

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export async function removeWorktree(repoPath: string, worktreePath: string, force: boolean): Promise<void> {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(worktreePath);
  await git(repoPath, args, 30_000);
  await git(repoPath, ['worktree', 'prune']);
}

/**
 * Clear stale worktree registrations — entries whose folder git can no longer
 * reach. Only touches git's own bookkeeping; no files are deleted.
 */
export async function pruneRegistrations(repoPath: string): Promise<void> {
  await git(repoPath, ['worktree', 'prune']);
}

export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  await git(repoPath, ['branch', '-D', branch]);
}

/**
 * Cut a new branch and a worktree for it in one move, from an explicit start
 * point. This is the one git write that grows something: a sprout ends here,
 * with `origin/<default>` as the start so the work begins on current code.
 */
export async function addWorktreeOnNewBranch(
  repoPath: string,
  path: string,
  branch: string,
  startPoint: string,
): Promise<void> {
  await git(repoPath, ['worktree', 'add', '--no-track', '-b', branch, path, startPoint], 180_000);
}

/** git needs an identity to commit; borrow one only when the repo has none. */
async function identityArgs(cwd: string): Promise<string[]> {
  const args: string[] = [];
  for (const [key, value] of [
    ['user.email', 'terrarium@localhost'],
    ['user.name', 'Terrarium'],
  ]) {
    try {
      const set = (await git(cwd, ['config', key])).trim();
      if (!set) args.push('-c', `${key}=${value}`);
    } catch {
      args.push('-c', `${key}=${value}`);
    }
  }
  return args;
}

/**
 * Commit some paths, if they have anything to commit.
 *
 * This exists for the plan file. A worktree is checked out from the base
 * branch, so a plan that is only an untracked file in the main checkout simply
 * is not there when ralphex goes looking for it. Committing it into the
 * worktree is what a person would do by hand, and it leaves the checkout clean.
 */
export async function commitPaths(
  cwd: string,
  paths: string[],
  message: string,
): Promise<{ committed: boolean }> {
  await git(cwd, ['add', '--', ...paths]);
  try {
    await git(cwd, ['diff', '--cached', '--quiet', '--', ...paths]);
    return { committed: false }; // nothing staged
  } catch {
    // A non-zero exit from --quiet is the signal that there *is* something.
  }
  const identity = await identityArgs(cwd);
  await git(cwd, [...identity, 'commit', '-q', '-m', message, '--', ...paths], 60_000);
  return { committed: true };
}

/** Whether git already knows about a path in this checkout. */
export async function isTracked(cwd: string, path: string): Promise<boolean> {
  try {
    const out = await git(cwd, ['ls-files', '--error-unmatch', '--', path]);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** Untracked or modified files in a checkout, repo-relative. */
export async function changedFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['status', '--porcelain', '--untracked-files=all']);
  const paths: string[] = [];
  for (const line of out.split('\n')) {
    if (line.length < 4) continue;
    const rest = line.slice(3);
    const arrow = rest.indexOf(' -> ');
    paths.push(arrow === -1 ? rest : rest.slice(arrow + 4));
  }
  return paths;
}
