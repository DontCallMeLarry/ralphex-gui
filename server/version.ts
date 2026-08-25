import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which copy of Terrarium is on the glass. The patch number is how many commits
 * this checkout carries, so it moves on its own with every push — there is no
 * number anywhere to remember to bump, and two people can tell in one glance
 * whether they are looking at the same code.
 */
export interface AppVersion {
  /** `v1.0.143` — the whole thing, ready to print. */
  label: string;
  /** When that commit was made, ISO, or null outside a git checkout. */
  updatedAt: string | null;
  /** The commit itself, short. For the line's tooltip and nowhere else. */
  commit: string | null;
}

const cached = new Map<string, AppVersion>();

/**
 * Read once per process: the answer only changes when the code does, and new
 * code means a restart (a repot restarts, and so does `npm start`).
 */
export function appVersion(appRoot: string): AppVersion {
  const known = cached.get(appRoot);
  if (known) return known;
  const fresh = read(appRoot);
  cached.set(appRoot, fresh);
  return fresh;
}

function read(appRoot: string): AppVersion {
  const base = declaredVersion(appRoot);
  try {
    const line = execFileSync('git', ['log', '-1', '--format=%h %cI'], {
      cwd: appRoot,
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const count = execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: appRoot,
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const [commit, updatedAt] = line.split(' ');
    return {
      label: `v${base}.${count}`,
      updatedAt: updatedAt ?? null,
      commit: commit ?? null,
    };
  } catch {
    // A zip download, or git missing: the declared version still says something.
    return { label: `v${base}.0`, updatedAt: null, commit: null };
  }
}

/** `major.minor` from package.json — the half a human chooses. */
function declaredVersion(appRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as { version?: string };
    const parts = String(pkg.version ?? '').split('.');
    if (parts.length >= 2 && parts[0] && parts[1]) return `${parts[0]}.${parts[1]}`;
  } catch {
    // fall through
  }
  return '0.0';
}
