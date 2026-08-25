/**
 * What a specimen's branch actually carries.
 *
 * ralphex commits per task and never pushes, so the deliverable is a branch.
 * This answers the question the developer has the moment a run ends — what
 * changed, in which commits — without leaving the browser. Terrarium always
 * runs ralphex inside the specimen's own worktree, so there is no hunting for
 * where the work landed: it landed here.
 */
import { existsSync } from 'node:fs';
import { git, getDefaultBranch, stageAll } from '../git.ts';

const MAX_COMMITS = 60;
const MAX_FILES = 300;

const STATUS_LABELS: Record<string, string> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type changed',
};

export interface ChangedFile {
  status: string;
  label: string;
  path: string;
  renamedFrom: string | null;
  added: number | null;
  removed: number | null;
}

export interface Commit {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

export interface Changes {
  available: boolean;
  reason?: string;
  branch?: string;
  base?: string;
  commits?: Commit[];
  commitCount?: number;
  truncatedCommits?: boolean;
  files?: ChangedFile[];
  fileCount?: number;
  totals?: { added: number; removed: number };
  uncommitted?: number;
  /**
   * How much of what is uncommitted is staged. Counted rather than assumed:
   * staging can be refused, and a screen that says "ready to review" about an
   * index nothing reached would be lying about the one thing it is for.
   */
  staged?: number;
}

async function quiet(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args, 30_000);
  } catch {
    return '';
  }
}

/**
 * @param worktreePath the specimen's worktree
 * @param branch the specimen's branch
 * @param repoPath the parent repo, used to find the branch to compare against
 */
export async function inspectChanges(
  worktreePath: string,
  branch: string,
  repoPath: string | null,
): Promise<Changes> {
  if (!existsSync(worktreePath)) {
    return {
      available: false,
      reason: 'The worktree this ran in is gone, so there is nothing left to show.',
    };
  }

  const base = await baseFor(worktreePath, repoPath, branch);
  if (!base) {
    return {
      available: false,
      branch,
      reason: 'This repo has no main branch to compare the work against, so there is nothing to show.',
    };
  }

  const range = `${base}...${branch}`;
  const [logOut, statusOut, numstatOut] = await Promise.all([
    quiet(worktreePath, ['log', `--max-count=${MAX_COMMITS}`, '--format=%h%x00%an%x00%aI%x00%s', `${base}..${branch}`]),
    quiet(worktreePath, ['diff', '--name-status', '-M', range]),
    quiet(worktreePath, ['diff', '--numstat', range]),
  ]);

  const commits: Commit[] = logOut
    ? logOut
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash, author, date, ...subject] = line.split('\0');
          return { hash, author, date, subject: subject.join('\0') };
        })
    : [];

  const churn = new Map<string, { added: number | null; removed: number | null }>();
  for (const line of numstatOut.split('\n').filter(Boolean)) {
    const [added, removed, file] = line.split('\t');
    churn.set(file, {
      added: added === '-' ? null : Number(added),
      removed: removed === '-' ? null : Number(removed),
    });
  }

  const files: ChangedFile[] = statusOut
    .split('\n')
    .filter(Boolean)
    .slice(0, MAX_FILES)
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      const file = rest[rest.length - 1];
      const code = status[0];
      return {
        status: code,
        label: STATUS_LABELS[code] || status,
        path: file,
        renamedFrom: code === 'R' && rest.length > 1 ? rest[0] : null,
        ...(churn.get(file) || { added: null, removed: null }),
      };
    });

  const totals = files.reduce(
    (acc, file) => ({ added: acc.added + (file.added || 0), removed: acc.removed + (file.removed || 0) }),
    { added: 0, removed: 0 },
  );

  // Whatever the run left loose goes into the index before it is counted, so
  // the diff is waiting in the editor's source control rather than scattered
  // across a working tree somebody has to go and find it in.
  await stageAll(worktreePath);
  const dirty = await quiet(worktreePath, ['status', '--porcelain=v1']);
  const loose = dirty.split('\n').filter(Boolean);

  return {
    available: commits.length > 0 || files.length > 0,
    reason: commits.length === 0 && files.length === 0 ? 'Nothing committed to this branch yet.' : undefined,
    branch,
    base,
    commits,
    commitCount: commits.length,
    truncatedCommits: commits.length === MAX_COMMITS,
    files,
    fileCount: files.length,
    totals,
    uncommitted: loose.length,
    // The first column is the index. Anything but a space (or an unmerged
    // path's "U") is work already staged and ready to read.
    staged: loose.filter((line) => line[0] !== ' ' && line[0] !== '?' && line[0] !== 'U').length,
  };
}

/**
 * What to diff against. `origin/<default>` where the repo has a remote, since
 * that is what the worktree was cut from; the local default branch otherwise.
 */
async function baseFor(worktreePath: string, repoPath: string | null, branch: string): Promise<string | null> {
  const name = repoPath ? await getDefaultBranch(repoPath) : null;
  for (const candidate of [name ? `origin/${name}` : null, name, 'origin/main', 'main', 'master']) {
    if (!candidate || candidate === branch) continue;
    const found = await quiet(worktreePath, ['rev-parse', '--verify', '--quiet', candidate]);
    if (found.trim()) return candidate;
  }
  return null;
}
