/**
 * Cutting a run into stages, so token usage can be attributed to one.
 *
 * ralphex marks its own boundaries. Every phase engine calls PrintSection,
 * which writes "\n--- {label} ---\n" with labels built from a typed Section:
 * "task iteration 3", "claude review 1: critical/major", "codex iteration 2",
 * "finalize". Those lines are already in the transcript Terrarium records, so
 * the stage timeline costs nothing extra to build and matches what ralphex
 * thinks it is doing rather than what a regex guessed. They are also the
 * chapter breaks the transcript draws.
 *
 * When a run has no section headers at all — an older ralphex, a wrapper
 * script — this falls back to Terrarium's own phase classification and cuts a
 * stage at each phase change. Coarser, still useful.
 */
import { PHASE_IDS, type Phase } from '../phases.ts';

// The section header ralphex prints between stages. Deliberately strict: a
// line of prose that happens to contain dashes must not open a stage.
const SECTION = /^\s*-{3}\s+(.+?)\s+-{3}\s*$/;

export type StageKind = 'setup' | 'task' | 'review' | 'external' | 'plan' | 'finalize' | 'other' | Phase;

export interface Section {
  label: string;
  kind: StageKind;
  phase: Phase;
  index: number | null;
}

export interface Stage extends Section {
  key: string;
  from: number;
  /** null while the stage is still open. */
  to: number | null;
  lines: number;
}

// label -> {kind, phase, index}. Order matters; first match wins.
const LABELS: Array<{ re: RegExp; kind: StageKind; phase: Phase }> = [
  { re: /^task iteration (\d+)$/i, kind: 'task', phase: 'task' },
  { re: /^claude review (\d+)/i, kind: 'review', phase: 'review' },
  { re: /^review (\d+)/i, kind: 'review', phase: 'review' },
  { re: /^codex iteration (\d+)$/i, kind: 'external', phase: 'external' },
  { re: /^custom review iteration (\d+)$/i, kind: 'external', phase: 'external' },
  { re: /^claude evaluating codex findings$/i, kind: 'external', phase: 'external' },
  { re: /^plan iteration (\d+)$/i, kind: 'plan', phase: 'setup' },
  { re: /^finalize/i, kind: 'finalize', phase: 'finalize' },
];

/** Read a stage boundary out of one output line, or null when it is not one. */
export function parseSection(text: string, fallbackPhase: string = 'setup'): Section | null {
  const match = SECTION.exec(String(text || ''));
  if (!match) return null;
  const label = match[1].trim();
  if (!label) return null;

  for (const rule of LABELS) {
    const hit = rule.re.exec(label);
    if (!hit) continue;
    return {
      label,
      kind: rule.kind,
      phase: rule.phase,
      index: hit[1] === undefined ? null : Number(hit[1]),
    };
  }
  // An unrecognised section is still a real boundary — ralphex only prints
  // these deliberately. Take its phase from Terrarium's own classification.
  return {
    label,
    kind: 'other',
    phase: PHASE_IDS.includes(fallbackPhase as Phase) ? (fallbackPhase as Phase) : 'setup',
    index: null,
  };
}

function stageKey(section: Section, ordinal: number): string {
  const base =
    section.index === null
      ? section.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      : `${section.kind}-${section.index}`;
  return `${ordinal}:${base || section.kind}`;
}

export interface TimelineEvent {
  ts: number;
  phase?: string;
  text: string;
}

/** Cut a run's events into stages. */
export function buildTimeline(
  events: TimelineEvent[] = [],
  run: { startedAt?: string | number | null; endedAt?: string | number | null } = {},
): { stages: Stage[]; sectioned: boolean } {
  const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : (events[0]?.ts ?? Date.now());
  const endedAt = run.endedAt ? new Date(run.endedAt).getTime() : null;

  const stages: Stage[] = [];
  let ordinal = 0;

  const open = (section: Section, at: number) => {
    const previous = stages[stages.length - 1];
    if (previous) previous.to = at;
    ordinal += 1;
    stages.push({ ...section, key: stageKey(section, ordinal), from: at, to: null, lines: 0 });
  };

  // Everything before the first section header is the run getting going:
  // config, branch, plan file. Real work, and it can spend tokens.
  open({ label: 'startup', kind: 'setup', phase: 'setup', index: null }, startedAt);

  let sectioned = false;
  for (const event of events) {
    const section = parseSection(event.text, event.phase);
    if (section) {
      sectioned = true;
      open(section, event.ts);
      continue;
    }
    stages[stages.length - 1].lines += 1;
  }

  // No section headers anywhere: fall back to cutting at phase changes.
  if (!sectioned && events.length) {
    stages.length = 0;
    ordinal = 0;
    let phase: string | null = null;
    for (const event of events) {
      const eventPhase = event.phase ?? 'setup';
      if (eventPhase !== phase) {
        phase = eventPhase;
        open({ label: phase, kind: phase as StageKind, phase: phase as Phase, index: null }, event.ts);
      }
      stages[stages.length - 1].lines += 1;
    }
    // Keep the run's own start, so usage from before the first line still lands.
    if (stages.length) stages[0].from = Math.min(stages[0].from, startedAt);
  }

  const last = stages[stages.length - 1];
  if (last && endedAt) last.to = endedAt;
  return { stages, sectioned };
}

/**
 * Attribute a timestamp to a stage.
 *
 * Usage arrives from a file the agent wrote, not from Terrarium's own stream,
 * so a sample can land microseconds outside the timeline. Clamping is right
 * here: a token spent by a run belongs to that run, and the nearest stage is
 * the only honest answer.
 */
export function stageAt(stages: Stage[], ts: number): Stage | null {
  if (!stages.length) return null;
  if (ts <= stages[0].from) return stages[0];
  let low = 0;
  let high = stages.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (stages[mid].from <= ts) low = mid;
    else high = mid - 1;
  }
  return stages[low];
}
