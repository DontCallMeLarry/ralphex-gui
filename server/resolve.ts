import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  addWorktree,
  branchExists,
  commitLines,
  createBackupRef,
  deleteRef,
  divergence,
  dirtyPaths,
  getDefaultBranch,
  hasOrigin,
  listBackupRefs,
  listWorktrees,
  mergeBase,
  moveBranchTo,
  rebaseOnto,
  removeWorktree,
  resetHard,
} from './git.ts';
import type { Freshener } from './freshen.ts';
import type { RepoInfo, RepoSyncState } from './types.ts';

/**
 * What to do about a default branch Terrarium refused to move on its own.
 *
 * The automatic pass only ever fast-forwards; anything that would rewrite a
 * local commit stops and reports. That report is only half an answer, so this
 * is the other half: a human picks the resolution, and it happens here under
 * the same rules — the branch tip is parked on a backup ref first, a dirty
 * worktree is never touched, and a rebase that hits a conflict is unwound
 * rather than left half-done.
 */
export type ResolveAction = 'rebase' | 'reset';

export class ResolveError extends Error {}

/** Everything the resolve dialog renders, read fresh from git (no network). */
export async function readSyncState(repo: RepoInfo, freshener: Freshener): Promise<RepoSyncState> {
  const state: RepoSyncState = {
    repo: repo.name,
    path: repo.path,
    hasOrigin: false,
    defaultBranch: null,
    branchExists: false,
    ahead: 0,
    behind: 0,
    unrelated: false,
    local: [],
    remote: [],
    checkedOutIn: null,
    dirty: false,
    dirtyFiles: [],
    dirtyCount: 0,
    backups: [],
    sync: freshener.last(repo.name),
  };
  if (repo.error !== null || !repo.path) return state;

  state.hasOrigin = await hasOrigin(repo.path);
  if (!state.hasOrigin) return state;

  const branch = await getDefaultBranch(repo.path);
  state.defaultBranch = branch;
  if (!branch) return state;
  state.branchExists = await branchExists(repo.path, branch);
  if (!state.branchExists) return state;

  const compare = await divergence(repo.path, `refs/heads/${branch}`, `refs/remotes/origin/${branch}`);
  if (compare) {
    state.ahead = compare.ahead;
    state.behind = compare.behind;
  }
  state.unrelated =
    (await mergeBase(repo.path, `refs/heads/${branch}`, `refs/remotes/origin/${branch}`)) === null;
  state.local = await commitLines(repo.path, `refs/remotes/origin/${branch}..refs/heads/${branch}`);
  state.remote = await commitLines(repo.path, `refs/heads/${branch}..refs/remotes/origin/${branch}`);

  const holder = (await listWorktrees(repo.path)).find((wt) => wt.branch === branch && wt.exists);
  state.checkedOutIn = holder?.path ?? null;
  if (holder) {
    const dirty = await dirtyPaths(holder.path).catch(() => []);
    state.dirty = dirty.length > 0;
    state.dirtyCount = dirty.length;
    state.dirtyFiles = dirty.slice(0, 20);
  }
  state.backups = await listBackupRefs(repo.path, branch);
  return state;
}

/**
 * Carry out one resolution. Returns the sentence the UI shows afterwards plus
 * the backup ref that makes it reversible.
 */
export async function resolveRepo(
  repo: RepoInfo,
  action: ResolveAction,
  freshener: Freshener,
): Promise<{ message: string; backupRef: string }> {
  const state = await readSyncState(repo, freshener);
  const branch = state.defaultBranch;
  if (!state.hasOrigin || !branch) throw new ResolveError(`${repo.name} has no origin to resolve against.`);
  if (!state.branchExists) throw new ResolveError(`${repo.name} has no local ${branch} to resolve.`);
  if (state.ahead === 0) {
    throw new ResolveError(
      `Local ${branch} has nothing origin/${branch} doesn't, so there is nothing to rewrite. Refresh to fast-forward it.`,
    );
  }
  if (state.checkedOutIn && state.dirty) {
    throw new ResolveError(
      `${branch} is checked out in ${basename(state.checkedOutIn)} with uncommitted changes. Commit or stash there first — Terrarium will not rewrite a branch out from under a dirty worktree.`,
    );
  }

  // The undo path, created before anything moves. `stamp` doubles as the ref's
  // name and its timestamp, so the backup list reads chronologically. A rewrite
  // that never happened leaves no backup behind — a list of refs that all point
  // at the same untouched tip would only be noise.
  const backupRef = await createBackupRef(repo.path, branch, Date.now());
  const target = `refs/remotes/origin/${branch}`;
  const kept = state.ahead;

  try {
    if (action === 'reset') {
      // `git branch --force` when nothing holds the branch; a hard reset when a
      // (verified clean) worktree does, since git won't move a checked-out ref.
      if (state.checkedOutIn) await resetHard(state.checkedOutIn, target);
      else await moveBranchTo(repo.path, branch, target);
      return {
        backupRef,
        message: `${branch} now matches origin/${branch}. The ${kept} local commit${
          kept === 1 ? '' : 's'
        } ${kept === 1 ? 'is' : 'are'} still reachable at ${backupRef}.`,
      };
    }

    // Rebase needs a working copy. When the branch is checked out we use that
    // one; when it isn't, a throwaway checkout in the system temp dir does the
    // job and is torn down before this call returns, so it never lingers long
    // enough to be discovered as a specimen.
    if (state.checkedOutIn) {
      await rebaseOnto(state.checkedOutIn, target).catch(rebaseFailed(branch, state.unrelated));
    } else {
      const scratch = await mkdtemp(join(tmpdir(), 'terrarium-rebase-'));
      const worktree = join(scratch, repo.name);
      try {
        await addWorktree(repo.path, worktree, branch);
        await rebaseOnto(worktree, target).catch(rebaseFailed(branch, state.unrelated));
      } finally {
        await removeWorktree(repo.path, worktree, true).catch(() => {});
        await rm(scratch, { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch (err) {
    await deleteRef(repo.path, backupRef).catch(() => {});
    throw err;
  }

  return {
    backupRef,
    message: `Replayed ${kept} local commit${kept === 1 ? '' : 's'} on top of origin/${branch}. The pre-rebase tip is kept at ${backupRef}.`,
  };
}

/**
 * A conflicted rebase has already been aborted by the time this runs — the
 * branch is untouched, and the only useful thing left to say is that a human
 * has to do this one in a terminal.
 */
function rebaseFailed(branch: string, unrelated: boolean) {
  return (err: unknown): never => {
    throw new ResolveError(
      `Rebasing ${branch} onto origin/${branch} hit conflicts, so it was aborted and nothing changed.${
        unrelated ? ' Branches with no shared history usually conflict on every file they both contain.' : ''
      }\n\n${gitComplaint(err)}`,
    );
  };
}

/**
 * The one line of a failed git invocation worth showing. Git narrates progress
 * on the same stream as its errors (carriage-returned, no less), so the useful
 * sentence is rarely the first one.
 */
function gitComplaint(err: unknown): string {
  const message = (err as Error).message ?? String(err);
  const lines = message
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^(Command failed:|Rebasing \()/.test(l));
  return lines.find((l) => /^(CONFLICT|error:|fatal:)/.test(l)) ?? lines[0] ?? message.trim();
}
