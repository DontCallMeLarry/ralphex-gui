/**
 * The plan a second pass gets.
 *
 * A finished specimen that needs a change does not need the interview again.
 * The interview exists to work out what to build; this is somebody looking at
 * built work and saying what is wrong with it, which is a much smaller
 * question and already has its answer. So nothing is asked and no model is
 * spawned to design anything: the note becomes a plan of its own, here, in
 * ralphex's own format, and the loop runs it exactly as it runs any other.
 *
 * The point of a new file rather than more boxes on the old one is context.
 * ralphex reads the plan it is working on every pass, so appending to a plan
 * that is already done means paying for the whole finished design, forever,
 * to change one colour. What the next run actually needs to know is much
 * smaller: this already exists, here is what it is, here is what to change.
 * That summary is written from the finished plan and the branch itself, so it
 * costs nothing to produce and cannot describe work that did not happen.
 *
 * Nothing here designs anything. The steps are the developer's own words, one
 * per line, in the order they wrote them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { commitPaths } from '../git.ts';
import { parsePlan, slugify } from './plan.ts';
import { listPlanFiles } from './plans.ts';

/** What is already in the worktree, as the next run needs to hear it. */
export interface FinishedWork {
  /** The finished plan's title — the interview's words, not ours. */
  title: string | null;
  /** The steps it was built to, in order. */
  built: string[];
  branch: string;
  commits: number | null;
  files: number | null;
}

/** Past this many lines a note is prose, not a list, and is one step. */
const AS_A_LIST_UP_TO = 10;
/** A task heading is a label. The whole of an item lives on its checkbox. */
const HEADING_CHARS = 90;

/**
 * The note, split into steps — one per line, because that is how people write
 * a list of things that are wrong. Bullets, numbers and pasted checkboxes are
 * markers for the eye rather than part of what was asked, so they come off.
 */
export function changeItems(note: string): string[] {
  const lines = String(note ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^([-*+]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s*/, '').trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  // A paragraph that happens to wrap is one thing being asked for, not eight.
  if (lines.length > AS_A_LIST_UP_TO) return [lines.join(' ')];
  return lines;
}

/** Shortened for a heading, whole on the checkbox under it. */
function asHeading(item: string): string {
  return item.length <= HEADING_CHARS ? item : `${item.slice(0, HEADING_CHARS - 1).trimEnd()}…`;
}

/**
 * The follow-up plan: what is already here, then what to change about it.
 *
 * The overview does one job — stop the loop rebuilding what it built. It says
 * the work exists, names it, counts it, and says plainly that everything below
 * is a correction. Without that a fresh run reads a plan of three small steps
 * and no history and reasonably concludes it is starting a project.
 */
export function revisePlan(work: FinishedWork, note: string): string {
  const items = changeItems(note);
  if (items.length === 0) throw new Error('Say what you want changed.');

  const name = work.title?.trim() || work.branch;
  const size = [
    work.commits === null ? null : `${work.commits} commit${work.commits === 1 ? '' : 's'}`,
    work.files === null ? null : `${work.files} file${work.files === 1 ? '' : 's'}`,
  ]
    .filter(Boolean)
    .join(' over ');

  const out: string[] = [];
  out.push(`# ${name}: changes`, '');
  out.push('## Overview', '');
  out.push(
    `${name} is already built in this worktree and committed to \`${work.branch}\`` +
      `${size ? ` — ${size}` : ''}. Every step of the plan it was built to is ticked.`,
  );
  out.push('');
  out.push(
    'That work stands. Nothing below is a reason to rebuild it, re-plan it or start again: ' +
      'each step is a correction to what is already there, and anything not named below is to be ' +
      'left exactly as it is. Read the existing code first and change the least that will do.',
  );
  if (work.built.length) {
    out.push('', 'What is already built:', '');
    for (const step of work.built) out.push(`- ${step}`);
  }
  out.push('', 'What was asked for, in the developer\'s own words:', '');
  for (const line of String(note).split(/\r?\n/)) out.push(`> ${line.trim()}`);
  out.push('');

  items.forEach((item, i) => {
    out.push(`### Task ${i + 1}: ${asHeading(item)}`, '');
    out.push(`- [ ] ${item}`, '');
  });

  return `${out.join('\n').trimEnd()}\n`;
}

/**
 * A name for it that no plan in the directory already has.
 *
 * Deliberately not the branch's own stem: that is the finished plan's name,
 * and two files answering to it would leave which one a specimen is working
 * up to whichever the directory listed first.
 */
export function revisePlanName(title: string | null, taken: (name: string) => boolean, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const base = `${stamp}-${slugify(title ?? '')}-changes`;
  let name = `${base}.md`;
  for (let n = 2; taken(name); n += 1) name = `${base}-${n}.md`;
  return name;
}

/** The steps of a finished plan, as plain descriptions for the summary. */
export function stepsOf(markdown: string): string[] {
  return parsePlan(markdown)
    .tasks.map((task) => task.description.trim())
    .filter(Boolean);
}

/**
 * Write the change plan into the worktree and commit it onto the branch.
 *
 * On the branch, like every other plan: ralphex ticks its boxes there as it
 * works, so a plan that is only an untracked file is not part of the change and
 * would not survive the worktree being looked at by anything else.
 */
export async function writeChangePlan(
  worktreePath: string,
  plansDir: string,
  work: FinishedWork,
  note: string,
): Promise<string> {
  const markdown = revisePlan(work, note);
  const dir = resolve(worktreePath, plansDir);
  const taken = new Set(listPlanFiles(worktreePath, plansDir).map((file) => basename(file)));
  const name = revisePlanName(work.title ?? work.branch, (candidate) => taken.has(candidate));
  const relative = `${plansDir.split(/[\\/]+/).filter(Boolean).join('/')}/${name}`;

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), markdown, 'utf8');
  await commitPaths(worktreePath, [relative], `Add plan: ${basename(name, '.md')}`);
  return relative;
}
