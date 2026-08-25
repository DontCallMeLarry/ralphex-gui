/**
 * Parser and linter for ralphex plan files.
 *
 * The format ralphex expects is narrow, and the failure mode for getting it
 * wrong is expensive rather than loud: a stray checkbox outside a task section
 * burns extra loop iterations instead of erroring. So this module is
 * deliberately strict and reports line numbers.
 *
 * Nothing here writes a plan. Plans come out of ralphex's own interview —
 * title, branch name and all — and this only reads what it wrote.
 *
 *   # Title
 *   ## Overview
 *   ### Task 1: Description
 *   - [ ] Checkpoint
 *
 * Only what ralphex trips over is a problem. Its plan prompt writes a bare
 * `# Title` and no `## Validation Commands` section — that section is a
 * convention for plans people write by hand, and nothing in ralphex reads it —
 * so demanding either would put a problem on every plan this interview
 * produces, about a document nobody on this screen wrote or can edit.
 */

const TASK_HEADING = /^###\s+(Task|Iteration)\s+([^:]+?):\s*(.*)$/i;
const ANY_HEADING = /^(#{1,6})\s+(.*)$/;
const CHECKBOX = /^(\s*)[-*]\s+\[([ xX])\]\s*(.*)$/;
const BACKTICKED = /`([^`]+)`/;

export const SEVERITY = { ERROR: 'error', WARNING: 'warning', INFO: 'info' } as const;
export type Severity = (typeof SEVERITY)[keyof typeof SEVERITY];

export interface Diagnostic {
  severity: Severity;
  code: string;
  line: number;
  message: string;
  hint: string;
}

export interface Checkbox {
  checked: boolean;
  text: string;
  line: number;
}

export interface PlanTask {
  kind: 'Task' | 'Iteration';
  number: string;
  description: string;
  line: number;
  checkboxes: Checkbox[];
  total: number;
  done: number;
}

export interface PlanProgress {
  checkboxes: { done: number; total: number };
  tasks: { done: number; total: number };
  percent: number;
  complete: boolean;
}

export interface PlanAnalysis {
  title: string | null;
  overview: string;
  validationCommands: Array<{ command: string; line: number }>;
  tasks: PlanTask[];
  diagnostics: Diagnostic[];
  progress: PlanProgress;
  valid: boolean;
}

function diag(severity: Severity, code: string, line: number, message: string, hint: string): Diagnostic {
  return { severity, code, line, message, hint };
}

interface WorkingTask {
  kind: 'Task' | 'Iteration';
  number: string;
  description: string;
  line: number;
  checkboxes: Checkbox[];
}

/**
 * Parse a plan file into structured form. Never throws: malformed input comes
 * back as diagnostics.
 */
export function parsePlan(source: string): PlanAnalysis {
  const text = typeof source === 'string' ? source : '';
  const lines = text.split(/\r?\n/);

  const diagnostics: Diagnostic[] = [];
  const tasks: WorkingTask[] = [];
  const validationCommands: Array<{ command: string; line: number }> = [];
  const overviewLines: string[] = [];

  let title: string | null = null;
  let titleLine = 0;
  let currentSection: string | null = null; // lowercased h2 text
  let currentTask: WorkingTask | null = null;
  let sawOverview = false;
  let inFence = false;
  let fenceMarker = '';

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const lineNo = i + 1;
    const trimmed = raw.trim();

    // Fenced code blocks are opaque: a "### Task" inside an example must not
    // be mistaken for a real task.
    const fence = trimmed.match(/^(```+|~~~+)/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
      } else if (fence[1][0] === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }
    if (inFence) continue;

    const heading = raw.match(ANY_HEADING);
    if (heading) {
      const level = heading[1].length;
      const headingText = heading[2].trim();

      if (level === 1) {
        if (title === null) {
          titleLine = lineNo;
          // "# Plan: Title" is how the README writes one by hand; the
          // interview writes a bare "# Title". Both are the title.
          const planPrefix = headingText.match(/^Plan:\s*(.+)$/i);
          title = planPrefix ? planPrefix[1].trim() : headingText;
        }
        currentSection = null;
        currentTask = null;
        continue;
      }

      const taskMatch = raw.match(TASK_HEADING);
      if (taskMatch) {
        const kind = taskMatch[1].toLowerCase() === 'iteration' ? 'Iteration' : 'Task';
        const number = taskMatch[2].trim();
        const description = taskMatch[3].trim();
        currentTask = { kind, number, description, line: lineNo, checkboxes: [] };
        tasks.push(currentTask);
        if (!description) {
          diagnostics.push(
            diag(
              SEVERITY.WARNING,
              'W006',
              lineNo,
              `${kind} ${number} has no description`,
              'ralphex feeds the heading text to the model as the task brief.',
            ),
          );
        }
        continue;
      }

      if (level === 2) {
        currentSection = headingText.toLowerCase();
        currentTask = null;
        if (currentSection === 'overview') sawOverview = true;
        continue;
      }

      // Any other h3+ ends the current task's checkbox scope.
      if (level >= 3) {
        currentTask = null;
        if (/^(task|iteration)\b/i.test(headingText)) {
          diagnostics.push(
            diag(
              SEVERITY.ERROR,
              'E006',
              lineNo,
              `Heading looks like a task but does not match "### ${headingText.split(/\s+/)[0]} N: description"`,
              'ralphex only recognises "### Task N:" or "### Iteration N:" (with the colon).',
            ),
          );
        }
      }
      continue;
    }

    const checkbox = raw.match(CHECKBOX);
    if (checkbox) {
      const entry: Checkbox = {
        checked: checkbox[2].toLowerCase() === 'x',
        text: checkbox[3].trim(),
        line: lineNo,
      };
      if (currentTask) {
        currentTask.checkboxes.push(entry);
      } else {
        const where = currentSection ? `the "${currentSection}" section` : 'no task section';
        diagnostics.push(
          diag(
            SEVERITY.ERROR,
            'E003',
            lineNo,
            `Checkbox in ${where}, outside any task`,
            'ralphex counts every checkbox as work to do. Checkboxes outside "### Task N:" sections cause extra loop iterations. Use plain bullets ("- item") here.',
          ),
        );
      }
      continue;
    }

    if (currentSection === 'validation commands' && trimmed.startsWith('-')) {
      const body = trimmed.replace(/^[-*]\s*/, '');
      const backticked = body.match(BACKTICKED);
      if (backticked) {
        validationCommands.push({ command: backticked[1].trim(), line: lineNo });
      } else if (body) {
        validationCommands.push({ command: body, line: lineNo });
        diagnostics.push(
          diag(
            SEVERITY.WARNING,
            'W005',
            lineNo,
            'Validation command is not wrapped in backticks',
            'Write it as - `npm test`, so the command reads as a command.',
          ),
        );
      }
      continue;
    }

    if (currentSection === 'overview' && trimmed) overviewLines.push(trimmed);
  }

  if (inFence) {
    diagnostics.push(
      diag(SEVERITY.WARNING, 'W007', lines.length, 'Unclosed code fence', 'Everything after the opening fence was ignored.'),
    );
  }

  if (title === null) {
    diagnostics.push(diag(SEVERITY.ERROR, 'E007', 1, 'No title heading', 'A plan starts with "# Some title".'));
  }

  if (!sawOverview) {
    diagnostics.push(
      diag(
        SEVERITY.WARNING,
        'W002',
        titleLine || 1,
        'No "## Overview" section',
        'The overview is the only place the model learns why the plan exists.',
      ),
    );
  }

  if (tasks.length === 0) {
    diagnostics.push(
      diag(SEVERITY.ERROR, 'E004', titleLine || 1, 'No tasks found', 'A plan needs at least one "### Task 1: description" section.'),
    );
  }

  const seenNumbers = new Map<string, number>();
  for (const task of tasks) {
    if (task.checkboxes.length === 0) {
      diagnostics.push(
        diag(
          SEVERITY.WARNING,
          'E005',
          task.line,
          `${task.kind} ${task.number} has no checkboxes`,
          'A task with no checkboxes gives ralphex nothing to mark complete.',
        ),
      );
    }
    const key = `${task.kind.toLowerCase()} ${task.number}`;
    if (seenNumbers.has(key)) {
      diagnostics.push(
        diag(
          SEVERITY.WARNING,
          'W003',
          task.line,
          `Duplicate ${task.kind.toLowerCase()} number "${task.number}"`,
          `Also used on line ${seenNumbers.get(key)}. Progress reporting gets confusing.`,
        ),
      );
    } else {
      seenNumbers.set(key, task.line);
    }
  }

  const total = tasks.reduce((n, t) => n + t.checkboxes.length, 0);
  const done = tasks.reduce((n, t) => n + t.checkboxes.filter((c) => c.checked).length, 0);
  const tasksComplete = tasks.filter((t) => t.checkboxes.length > 0 && t.checkboxes.every((c) => c.checked)).length;

  return {
    title,
    overview: overviewLines.join(' '),
    validationCommands,
    tasks: tasks.map((t) => ({
      kind: t.kind,
      number: t.number,
      description: t.description,
      line: t.line,
      checkboxes: t.checkboxes,
      total: t.checkboxes.length,
      done: t.checkboxes.filter((c) => c.checked).length,
    })),
    diagnostics: diagnostics.sort((a, b) => a.line - b.line),
    progress: {
      checkboxes: { done, total },
      tasks: { done: tasksComplete, total: tasks.length },
      percent: total === 0 ? 0 : Math.round((done / total) * 100),
      complete: total > 0 && done === total,
    },
    valid: diagnostics.every((d) => d.severity !== SEVERITY.ERROR),
  };
}

/**
 * The stamp ralphex puts on the front of a plan filename: `20260824-` or
 * `2026-08-24-`. It sorts a plans directory, which is all it is for.
 */
const DATED = /^(?:\d{8}|\d{4}-\d{2}-\d{2})[-_]/;

/**
 * A plan filename without its date stamp — what the plan is actually called.
 *
 * The stamp belongs to the plans directory, where it keeps the files in order.
 * It has no business in a branch name or on the front of a worktree folder,
 * where it is eight digits of nothing between you and what the work is.
 */
export function withoutDatePrefix(name: string): string {
  return String(name || '').replace(DATED, '') || String(name || '');
}

/** The branch a plan grows on: its filename, without the date it was written. */
export function branchNameForPlan(planPath: string): string {
  const base = String(planPath).split('/').pop() || '';
  return withoutDatePrefix(base.replace(/\.md$/i, ''));
}

/** A worktree folder name that git and the filesystem both accept. */
export function slugify(title: string): string {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'untitled-plan';
}
