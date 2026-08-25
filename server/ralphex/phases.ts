/**
 * Classifies ralphex's stdout into phases, so a line can be placed without
 * anybody reading it.
 *
 * ralphex does not emit a machine-readable phase channel, so this is pattern
 * matching over human-readable output. It is a display aid: getting a line's
 * phase wrong changes which colour it carries in the folded machinery and
 * nothing else. The signal markers below, by contrast, are documented protocol
 * strings ralphex prints on purpose.
 */

export type Phase = 'setup' | 'task' | 'review' | 'external' | 'finalize';

export const PHASES: Array<{ id: Phase; label: string }> = [
  { id: 'setup', label: 'Setup' },
  { id: 'task', label: 'Task' },
  { id: 'review', label: 'Review' },
  { id: 'external', label: 'External' },
  { id: 'finalize', label: 'Finalize' },
];

export const PHASE_IDS: Phase[] = PHASES.map((p) => p.id);

export type Level = 'info' | 'warn' | 'error' | 'success';

export interface Marker {
  id: string;
  label: string;
  level: Level;
}

/** Documented ralphex signal strings. */
export const MARKERS: Record<string, Marker> = {
  '<<<RALPHEX:ALL_TASKS_DONE>>>': { id: 'all_tasks_done', label: 'All tasks done', level: 'success' },
  '<<<RALPHEX:TASK_FAILED>>>': { id: 'task_failed', label: 'Task failed', level: 'error' },
  '<<<RALPHEX:QUESTION>>>': { id: 'question', label: 'Needs an answer', level: 'warn' },
};

// CSI and OSC escape sequences, built from escapes so the source stays ASCII.
const ANSI = new RegExp('\\u001B\\[[0-9;?]*[ -/]*[@-~]|\\u001B\\][^\\u0007]*\\u0007', 'g');

export function stripAnsi(text: string): string {
  return String(text).replace(ANSI, '');
}

const RULES: Array<{ phase: Phase; re: RegExp }> = [
  { phase: 'external', re: /\b(codex|external review|phase\s*3)\b/i },
  { phase: 'review', re: /\b(first code review|second code review|review phase|review agent|reviewing|phase\s*[24])\b/i },
  { phase: 'review', re: /launching\s+\d+\s+agents?/i },
  { phase: 'finalize', re: /(\bfinaliz|\brebase|\bsquash|moving plan|completed\/)/i },
  { phase: 'task', re: /\b(task execution|executing task|task\s+\d+|iteration\s+\d+|phase\s*1)\b/i },
  { phase: 'setup', re: /\b(worktree|creating branch|checked out|plan file|starting|config loaded)\b/i },
];

const LEVELS: Array<{ level: Level; re: RegExp }> = [
  { level: 'error', re: /\b(error|fatal|failed|failure|panic|exception)\b/i },
  { level: 'warn', re: /\b(warn|warning|retrying|rate limit|timeout)\b/i },
  { level: 'success', re: /\b(passed|success|completed|done)\b/i },
];

export interface Classified {
  text: string;
  phase: Phase;
  level: Level;
  marker: Marker | null;
  phaseChanged: boolean;
}

/** Classify one output line. `previousPhase` is carried from the line before. */
export function classifyLine(line: string, previousPhase: Phase | string = 'setup'): Classified {
  const text = stripAnsi(line);

  let marker: Marker | null = null;
  for (const [needle, info] of Object.entries(MARKERS)) {
    if (text.includes(needle)) {
      marker = info;
      break;
    }
  }

  let phase: Phase = PHASE_IDS.includes(previousPhase as Phase) ? (previousPhase as Phase) : 'setup';
  for (const rule of RULES) {
    if (rule.re.test(text)) {
      phase = rule.phase;
      break;
    }
  }

  let level: Level = 'info';
  if (marker) {
    level = marker.level;
  } else {
    for (const rule of LEVELS) {
      if (rule.re.test(text)) {
        level = rule.level;
        break;
      }
    }
  }

  return { text, phase, level, marker, phaseChanged: phase !== previousPhase };
}

/**
 * Splits a byte stream into lines across chunk boundaries. Call flush() at
 * stream end to emit any trailing partial line.
 */
export function createLineSplitter(onLine: (line: string) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buffer = '';
  return {
    push(chunk: string) {
      buffer += chunk;
      // Keep the tail: it may be a partial line completed by the next chunk.
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? '';
      for (const part of parts) onLine(part);
    },
    flush() {
      if (buffer !== '') {
        const last = buffer;
        buffer = '';
        onLine(last);
      }
    },
  };
}
