import type { RalphexEvent } from './api.ts';

/**
 * What the loop is doing, said as something growing rather than as a stage of
 * a pipeline — but said plainly enough that nobody has to guess.
 *
 * ralphex marks its own boundaries — `--- task iteration 3 ---`, `--- review 1:
 * critical/major ---`, `--- finalize ---` — and the server reads each one into
 * a kind and an index. Those labels are how the machine talks about itself; a
 * row of them down the middle of the page is a log file wearing a border.
 *
 * So each one becomes three things. The phase, named outright, because "every
 * box is ticked and it is still going" is only unnerving until you know it is
 * reviewing. The plant sentence, which is that phase said the way the rest of
 * the terrarium talks. And whatever the label carried after its colon — which
 * pass this is, what it is looking for — because that is the part that says
 * this one is not the last. The index goes to a small counter off to one side,
 * where a number that only goes up belongs.
 */
const DOING: Record<string, { phase: string; doing: string }> = {
  setup: { phase: 'Setting up', doing: 'turning the soil' },
  plan: { phase: 'Planning', doing: 'drawing the plan up' },
  task: { phase: 'Building', doing: 'putting on new growth' },
  review: { phase: 'Reviewing', doing: 'going over it leaf by leaf' },
  external: { phase: 'Second opinion', doing: 'another pair of eyes over it' },
  finalize: { phase: 'Finishing', doing: 'tidying up and tying it back' },
  other: { phase: 'Working', doing: 'working away' },
};

export interface Growth {
  /** Which phase of the loop, named outright. Null before it has said anything. */
  phase: string | null;
  /** The same thing, said the way the rest of the terrarium talks. */
  doing: string | null;
  /** What the boundary carried after its colon — "critical/major" and the like. */
  detail: string | null;
  /** Which pass round the loop it is on, when the stage counts them. */
  pass: number | null;
  /**
   * When the run started, in epoch ms, or null before anything has happened.
   *
   * Read off the transcript rather than kept in the component, because the
   * whole transcript is replayed on every connect: closing the bench and
   * opening it again must not restart the clock on a run that never stopped.
   */
  startedAt: number | null;
}

const NOTHING: Growth = { phase: null, doing: null, detail: null, pass: null, startedAt: null };

/**
 * Which part of the loop is doing the talking, in a few words.
 *
 * Used where something arrives out of a run and has to say where it came from.
 * A question in the middle of a review is the loop stopping for no reason
 * anybody can see — until it says it is the review asking, and which pass.
 */
export function whoIsAsking(stage: unknown): string | null {
  if (!stage || typeof stage !== 'object') return null;
  const { kind, index, label } = stage as { kind?: unknown; index?: unknown; label?: unknown };
  const said = DOING[String(kind ?? 'other')] ?? DOING.other;
  const pass = typeof index === 'number' && Number.isFinite(index) ? ` · pass ${index}` : '';
  const text = String(label ?? '');
  const detail = text.slice(text.indexOf(':') + 1).trim();
  return `${said.phase}${pass}${text.includes(':') && detail ? ` — ${detail}` : ''}`;
}

/** Where the run has got to, read off the last boundary it printed. */
export function growthOf(events: RalphexEvent[]): Growth {
  if (events.length === 0) return NOTHING;
  const first = events[0].data.ts;
  const startedAt = typeof first === 'number' && Number.isFinite(first) ? first : null;

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type !== 'stage') continue;
    const kind = String(event.data.kind ?? 'other');
    const index = event.data.index;
    const said = DOING[kind] ?? DOING.other;
    // "claude review 1: critical/major" — the half after the colon is the only
    // part of the label worth a person's attention.
    const label = String(event.data.label ?? '');
    const detail = label.slice(label.indexOf(':') + 1).trim();
    return {
      phase: said.phase,
      doing: said.doing,
      detail: label.includes(':') && detail ? detail : null,
      pass: typeof index === 'number' && Number.isFinite(index) ? index : null,
      startedAt,
    };
  }
  return { ...NOTHING, startedAt };
}
