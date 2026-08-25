/**
 * Plan files on disk.
 *
 * A plan is written by ralphex's interview and then lives in the worktree it
 * describes, where ralphex ticks its checkboxes as each step lands. That makes
 * it two things at once: the design record a specimen is opened to read, and
 * the progress record the tending bench watches. Nothing here writes one.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parsePlan, withoutDatePrefix, type PlanAnalysis } from './plan.ts';

const MAX_DEPTH = 3;

export interface PlanDoc {
  /** Relative to the worktree, e.g. `docs/plans/add-health-check.md`. */
  file: string | null;
  markdown: string;
  analysis: PlanAnalysis | null;
  /** Where we looked, so "nothing here" can say where "here" is. */
  dir: string;
}

/** Markdown files under `<root>/<plansDir>`, newest last. */
export function listPlanFiles(root: string, plansDir: string): string[] {
  const start = resolve(root, plansDir);
  const out: string[] = [];
  walk(start, 0, out);
  return out.sort();
}

function walk(dir: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH || !existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, depth + 1, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(full);
  }
}

/**
 * Resolve a plan path that came from outside, refusing anything outside the
 * plans directory. Terrarium binds to localhost, but a traversal bug would
 * still turn a stray request into arbitrary file access.
 */
export function resolvePlanPath(root: string, plansDir: string, candidate: string): string | null {
  const planRoot = resolve(root, plansDir);
  const raw = String(candidate || '').trim();
  if (!raw || raw.includes('\0') || !raw.toLowerCase().endsWith('.md')) return null;
  const fromRoot = resolve(root, raw);
  const target = fromRoot.startsWith(`${planRoot}${sep}`) || fromRoot === planRoot ? fromRoot : resolve(planRoot, raw);
  const inside = relative(planRoot, target);
  if (inside.startsWith('..') || isAbsolute(inside)) return null;
  return target;
}

function read(file: string): PlanDoc | null {
  try {
    const markdown = readFileSync(file, 'utf8');
    return { file, markdown, analysis: parsePlan(markdown), dir: '' };
  } catch {
    return null;
  }
}

/**
 * The plan for a worktree.
 *
 * The recorded path wins, because that is the file the sprout committed. After
 * that the branch's own name, since the branch is the plan's filename with its
 * date stamp taken off, and then whichever plan was touched last — a worktree
 * that came from somewhere else still has something worth reading. ralphex
 * moves a finished plan into `completed/`, so that is searched too.
 */
export function findPlan(
  worktreePath: string,
  plansDir: string,
  branch: string,
  recorded: string | null = null,
): PlanDoc {
  const empty: PlanDoc = { file: null, markdown: '', analysis: null, dir: plansDir };
  if (!existsSync(worktreePath)) return empty;

  const candidates: string[] = [];
  if (recorded) {
    const resolved = resolvePlanPath(worktreePath, plansDir, recorded);
    if (resolved) candidates.push(resolved);
  }

  const files = listPlanFiles(worktreePath, plansDir);
  // The branch is the plan's filename without its date stamp, so the match is
  // made on both sides without one: `20260824-health-check.md` is the plan for
  // the branch `health-check`.
  const wanted = withoutDatePrefix(branch.slice(branch.lastIndexOf('/') + 1)).toLowerCase();
  for (const file of files) {
    if (stem(file) === wanted) candidates.push(file);
  }
  const dated = files
    .map((file) => ({ file, at: mtime(file) }))
    .sort((a, b) => b.at - a.at)
    .map((entry) => entry.file);
  candidates.push(...dated);

  const seen = new Set<string>();
  for (const file of candidates) {
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const doc = read(file);
    // A markdown file that parses as nothing is not this worktree's plan.
    if (doc && (doc.analysis?.title || doc.analysis?.tasks.length)) {
      return { ...doc, file: relative(worktreePath, file).split(sep).join('/'), dir: plansDir };
    }
  }
  return empty;
}

/** A plan file's name, without its extension and without its date stamp. */
function stem(file: string): string {
  return withoutDatePrefix(basename(file).replace(/\.md$/i, '')).toLowerCase();
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
