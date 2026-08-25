/**
 * Reads a ralphex transcript into the three things the glass needs from it:
 * the question it is waiting on, the plan that question is about, and, when it
 * stops, why.
 *
 * ralphex talks to a terminal. Asking something, it prints the question, then a
 * numbered list, and reads a line from stdin — and its progress log repeats the
 * same question with a timestamp glued to every wrapped line. None of that is
 * meant for someone who only wants to answer it, so this throws the terminal
 * away and keeps the sentence and the choices. Terrarium then draws them as a
 * question card, the same one the sprout flow has always drawn.
 */

export interface ReadoutEvent {
  seq: number;
  stream: string;
  text: string;
  level?: string;
}

export interface PickerOption {
  number: number;
  label: string;
  /** The escape hatch at the end of a list: type your own answer. */
  other: boolean;
}

/**
 * The two answers worth giving to a draft review, by the number the picker
 * wants typed for each.
 */
export interface DraftReview {
  accept: number;
  revise: number;
}

export interface PendingQuestion {
  /** The last option line — what makes one question later than another. */
  seq: number;
  /** The first line of the picker, so the whole of it can be folded away. */
  from: number;
  /** The line carrying the question itself, when it had one; 0 otherwise. */
  askedAt: number;
  question: string;
  options: PickerOption[];
  /**
   * Set when this picker is ralphex asking what to do with the plan it just
   * drafted. It is not a question anyone should be handed as four buttons: two
   * of its answers (opening an editor, rejecting) have no meaning through a
   * browser, and the other two are the flow's own two ways on.
   */
  review: DraftReview | null;
}

/**
 * A numbered list while it is still being collected, with the evidence that it
 * is a question and not just a list. Kept off `PendingQuestion` because by the
 * time one is returned the evidence has done its job.
 */
interface Picker extends PendingQuestion {
  /** The "QUESTION: ..." label this list opened under, if any. */
  labelled: string | null;
  /** ralphex printed the prompt it blocks on, or its own asking marker. */
  prompted: boolean;
}

const LOG_PREFIX = /^\[\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\s?/;
const OPTION = /^(\d{1,2})[).]\s+(.+?)\s*$/;
const LABELLED = /^(QUESTION|OPTIONS|END)\b:?\s*(.*)$/;
const OTHER = /^(other|something else)\b/i;
// The line a picker actually blocks on, and ralphex's own signal that it is
// asking. Either one says a numbered list is a question rather than a list.
const PROMPT = /^Enter (?:number|your choice)/i;
const ASKING = /<<<RALPHEX:QUESTION>>>/;
// A rule drawn across the terminal: ralphex's stage boundaries ("--- claude
// review 0: all findings ---") and the heavy frame around a draft. Neither is
// a sentence, so neither is ever the question a list underneath it answers.
const RULE = /^(?:-{2,}|\u2501{2,})\s*.*?\s*(?:-{2,}|\u2501{2,})$/;
// The stage boundaries among them, by the exact shape ralphex prints. One of
// these changes the subject, so the sentence before it belongs to what came
// before it — furniture does not, and taking a question away from somebody
// because a line of box-drawing sat under it would be worse than the bug.
const BOUNDARY = /^-{3}\s+.+?\s+-{3}$/;
// ralphex's draft review, by its option labels: Accept, Revise, Interactive
// review, Reject. Only the first two mean anything through a browser.
const ACCEPT = /^accept\b/i;
const REVISE = /^revise\b/i;

/** ralphex's progress log stamps every line, wrapped continuations included. */
export function stripLogPrefix(text: string | undefined | null): string {
  return String(text ?? '').replace(LOG_PREFIX, '');
}

// Lines that say nothing to the person watching. The progress log repeats the
// terminal with a timestamp glued on, and the protocol labels around a question
// are the same question a third time — so a transcript that shows them shows
// everything twice and buries the one sentence that matters.
const NOISE = [
  LOG_PREFIX,
  /^(QUESTION|OPTIONS|END|PLAN_READY|DRAFT REVIEW|ANSWER)\b/,
  /^<<<RALPHEX:[A-Z_]+>>>$/,
  /^progress log:/i,
  /^Enter (?:number|your choice)/i,
];

/**
 * True for a line that is machinery talking to itself: the progress log's
 * stamped copy of what the terminal already said, or one of the protocol
 * labels a picker is wrapped in. Kept out of the flow, still recorded — the
 * details panel has them when something needs debugging.
 */
export function isMachineryNoise(text: string | undefined | null): boolean {
  const line = String(text ?? '').trim();
  if (!line) return true;
  return NOISE.some((pattern) => pattern.test(line));
}

/**
 * The question ralphex is waiting on, or null.
 *
 * A question is the last numbered list in the transcript with nothing typed
 * after it, and with something saying it is one: a sentence above it, the
 * QUESTION protocol around it, the prompt it blocks on underneath, or the
 * unmistakable shape of a draft review. Two options are the minimum, since one
 * stray "1) ..." in prose is not somebody being asked something.
 *
 * That last requirement is the whole of the difference between a question and
 * a list. A review pass prints its findings the same way a picker prints its
 * choices — numbered, one per line, under a rule — and it prints them and
 * carries on working. Reading those as a question stops a run that never
 * stopped, hands the developer a card asking them to choose between two bugs,
 * and makes the stage rule above the list ("claude review 0: all findings")
 * the question it appears to be asking. So a list with nothing but a rule over
 * it is a list.
 */
export function pendingQuestion(events: ReadoutEvent[] = []): PendingQuestion | null {
  let block: Picker | null = null; // the numbered list being collected
  let labelled: string | null = null; // text of the last "QUESTION: ..." line
  let asking = false; // ralphex's own marker, printed before it asks
  let above = ''; // last plain line, which is what a list is answering
  let aboveSeq = 0; // and where it was, so it can be folded away with the list
  let answeredAt = 0; // seq of the last thing typed back
  // The last finished list, held on an object because `finish` is a closure and
  // a plain local would read as never-assigned everywhere after it.
  const found: { latest: Picker | null } = { latest: null };

  const finish = () => {
    if (block && block.options.length >= 2) {
      block.review = draftReviewIn(block.options);
      found.latest = block;
    }
    block = null;
  };

  for (const event of events) {
    if (event.stream === 'input') {
      answeredAt = event.seq;
      finish();
      labelled = null;
      asking = false;
      continue;
    }

    const line = stripLogPrefix(event.text);
    const stamped = line !== String(event.text ?? '');
    const trimmed = line.trim();

    const tagged = trimmed.match(LABELLED);
    if (tagged) {
      if (tagged[1] === 'QUESTION' && tagged[2]) labelled = tagged[2].trim();
      continue;
    }

    // What ralphex prints when it is about to block, and what it prints when it
    // already has. Either one is the list underneath saying it is a question.
    if (PROMPT.test(trimmed) || ASKING.test(trimmed)) {
      if (block) block.prompted = true;
      else asking = true;
      continue;
    }

    // A rule across the terminal: a stage boundary, or the frame round a
    // draft. Never the question itself, and a boundary also ends the sentence
    // above it — that one belongs to the stage that just closed. A QUESTION:
    // label survives either, because it is ralphex saying outright that it is
    // asking rather than a guess made from what happened to be nearby.
    if (RULE.test(trimmed)) {
      finish();
      if (BOUNDARY.test(trimmed)) {
        above = '';
        aboveSeq = 0;
      }
      continue;
    }

    const option = trimmed.match(OPTION);
    if (option) {
      const number = Number(option[1]);
      if (!block || number !== block.options.length + 1) {
        finish();
        if (number !== 1) continue;
        block = {
          seq: event.seq,
          from: event.seq,
          askedAt: above ? aboveSeq : 0,
          question: above,
          options: [],
          review: null,
          labelled,
          prompted: asking,
        };
        asking = false;
      }
      block.options.push({ number, label: option[2], other: OTHER.test(option[2]) });
      block.seq = event.seq;
      continue;
    }

    finish();
    // The terminal's own rendering of the question is unstamped; the stamped
    // copies are the progress log talking to itself.
    if (trimmed && !stamped) {
      above = trimmed;
      aboveSeq = event.seq;
    }
  }
  finish();

  const latest = found.latest;
  if (!latest || latest.seq <= answeredAt) return null;
  // Nothing said this was a question, so it was a list.
  if (!latest.question && !latest.labelled && !latest.prompted && !latest.review) return null;
  return {
    seq: latest.seq,
    from: latest.from,
    askedAt: latest.askedAt,
    question: latest.question || latest.labelled || 'It needs an answer to carry on.',
    options: latest.options,
    review: latest.review,
  };
}

/**
 * The draft review hiding in a picker's options, or null for an ordinary
 * question. Matched on the two labels that mean something here rather than on
 * the whole list, so an extra option or a reordering does not lose it.
 */
function draftReviewIn(options: PickerOption[]): DraftReview | null {
  const accept = options.find((option) => ACCEPT.test(option.label));
  const revise = options.find((option) => REVISE.test(option.label));
  if (!accept || !revise) return null;
  return { accept: accept.number, revise: revise.number };
}

// --------------------------------------------------------------- the plan

// A plan ralphex has written out, as it appears in the transcript: a markdown
// document with the shape server/ralphex/plan.ts expects.
const PLAN_TITLE = /^#\s+(?:Plan:\s*)?(.+?)\s*$/;
const PLAN_TASK = /^###\s+(?:Task|Iteration)\s+/i;
const CHECKBOX = /^\s*[-*]\s+\[[ xX]\]/;
// A plan file, wherever it is named: "wrote docs/plans/health-check.md".
const PLAN_FILE = /([\w.@/-]*\/)?([\w.-]+\.md)\b/;
const PLANS_DIR = /(^|\/)plans?(\/|$)/i;
// Markdown with a shape to it. A plan ends on its last one of these; the
// prose in an Overview counts as plan, ralphex's next sentence does not.
const STRUCTURE = /^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>|`{3}|\|)/;
// Where the plan stops and the terminal starts again is the same rule a picker
// is never allowed to take its question from: RULE, above.

export interface ProposedPlan {
  title: string | null;
  /** The markdown, when ralphex printed it. Empty when it only named a file. */
  text: string;
  /** The file it said it wrote, when it named one. */
  path: string | null;
  /**
   * The lines the plan was printed on, so the whole of it can be folded away:
   * the card above is the plan, and showing it twice is showing terminal output.
   * `[0, 0]` when nothing was printed.
   */
  drawnFrom: [number, number];
}

interface PlanLine {
  seq: number;
  text: string;
}

interface PlanBlock {
  title: string;
  lines: PlanLine[];
  tasks: number;
  checkboxes: number;
  gap: number;
}

/**
 * The plan ralphex is asking you to approve.
 *
 * Approving a plan you cannot see is the one thing this must never ask for,
 * and ralphex writes the plan two ways: it prints the markdown, or it writes
 * the file and names it. Both are read here; the caller shows whichever it
 * gets, and can go and read the file when only the name came back.
 */
export function proposedPlan(events: ReadoutEvent[] = []): ProposedPlan | null {
  const lines: PlanLine[] = []; // unstamped only, for the markdown
  const said: string[] = []; // every line, for what it says it wrote
  for (const event of events) {
    if (event.stream === 'input') continue;
    const line = stripLogPrefix(event.text);
    said.push(line);
    // The stamped copies are the progress log repeating itself, wrapped mid
    // word; a plan reassembled from those is not the plan. Naming the file it
    // wrote is the one thing that log does better, so that reads `said`.
    if (line !== String(event.text ?? '')) continue;
    lines.push({ seq: event.seq, text: line });
  }

  // Held on an object because `close` is a closure: a plain local would read
  // as never-assigned everywhere after it.
  const found: { best: PlanBlock | null } = { best: null };
  let block: PlanBlock | null = null;
  const close = () => {
    if (block && (block.tasks > 0 || block.checkboxes >= 2)) {
      // Anything trailing the plan's last structural line is ralphex talking
      // over the top of it, not the end of the plan.
      while (block.lines.length && !STRUCTURE.test(block.lines[block.lines.length - 1].text)) {
        block.lines.pop();
      }
      found.best = block;
    }
    block = null;
  };

  for (const entry of lines) {
    const line = entry.text;
    const trimmed = line.trim();
    const title = trimmed.match(PLAN_TITLE);
    if (title && !CHECKBOX.test(line)) {
      close();
      block = { title: title[1], lines: [entry], tasks: 0, checkboxes: 0, gap: 0 };
      continue;
    }
    if (!block) continue;

    // The terminal, resumed: a numbered choice, a labelled log line, or one of
    // ralphex's stage headers. Whatever else the plan is, it is not these.
    if (OPTION.test(trimmed) || LABELLED.test(trimmed) || RULE.test(trimmed)) {
      close();
      continue;
    }

    if (!trimmed) {
      block.gap += 1;
      // Two blank lines and nothing markdown after them is ralphex talking
      // again, not the plan continuing.
      if (block.gap > 2) {
        close();
        continue;
      }
      block.lines.push(entry);
      continue;
    }
    if (!STRUCTURE.test(line) && block.gap > 0) {
      close();
      continue;
    }
    block.gap = 0;
    if (PLAN_TASK.test(trimmed)) block.tasks += 1;
    if (CHECKBOX.test(line)) block.checkboxes += 1;
    block.lines.push(entry);
  }
  close();

  // The file, named anywhere in the transcript. Last one wins: an interview
  // that revised its plan named the new file after the old one.
  let file: string | null = null;
  for (const line of said) {
    const match = line.match(PLAN_FILE);
    if (!match) continue;
    const dir = match[1] || '';
    if (!PLANS_DIR.test(dir)) continue;
    file = `${dir}${match[2]}`;
  }

  const best = found.best;
  if (!best && !file) return null;
  return {
    title: best ? best.title : null,
    text: best ? best.lines.map((line) => line.text).join('\n').replace(/\n+$/, '') : '',
    path: file,
    drawnFrom: best && best.lines.length ? [best.lines[0].seq, best.lines[best.lines.length - 1].seq] : [0, 0],
  };
}

// Failures worth translating: what ralphex prints, and what it means for the
// person who pressed the button. Everything else falls through to its own words.
const KNOWN: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [
    /worktree creation requires (?:the )?main branch, currently on "?([^"\n]+?)"?\s*$/i,
    (m) =>
      `ralphex will only cut a worktree from the main branch, and this checkout was on “${m[1]}”. ` +
      'Terrarium already grows every specimen in a worktree of its own, so nothing here should be asking it to.',
  ],
  [/not installed or not on PATH/i, () => 'ralphex is not installed on this machine.'],
  [
    /(?:no|missing) plan file|plan file .*not found|could not (?:find|read) .*\.md/i,
    () => 'ralphex could not find the plan file.',
  ],
  [/\brate limit/i, () => 'Claude hit its rate limit. Wait a while and start again.'],
  [/authentication|not logged in|unauthorized/i, () => 'Claude is not logged in on this machine.'],
  [
    /uncommitted changes|working tree is dirty|please commit/i,
    () => 'This worktree has changes that are not committed, and a run has to start from a clean one.',
  ],
];

/** One sentence, capitalised, without the shell's punctuation habits. */
function plainest(text: string): string {
  let sentence = stripLogPrefix(text).trim();
  sentence = sentence.replace(/^error:\s*/i, '');
  // ralphex stacks context onto its errors: "create worktree: <what happened>".
  sentence = sentence.replace(/^[a-z]+(?: [a-z]+)?:\s+(?=.{20})/, '');
  if (!sentence) return '';
  return `${sentence[0].toUpperCase()}${sentence.slice(1)}${/[.!?]$/.test(sentence) ? '' : '.'}`;
}

export interface StoppedRun {
  status: string;
  error?: string | null;
}

/**
 * Why a run is not running any more, in a sentence, or null while it still is
 * (and when it simply finished, which speaks for itself).
 */
export function whyItStopped(run: StoppedRun | null, events: ReadoutEvent[] = []): string | null {
  if (!run || run.status === 'running' || run.status === 'starting' || run.status === 'succeeded') return null;
  if (run.status === 'cancelled' || run.status === 'aborted') return 'You stopped this run.';
  if (run.status === 'interrupted') return 'Terrarium was restarted while this was running.';

  const errors = events
    .filter((event) => event.level === 'error')
    .map((event) => stripLogPrefix(event.text).trim())
    .filter(Boolean);

  for (const line of [...errors].reverse()) {
    for (const [pattern, say] of KNOWN) {
      const match = line.match(pattern);
      if (match) return say(match);
    }
  }
  if (run.error) return plainest(run.error);
  const last = errors[errors.length - 1];
  return last ? plainest(last) : 'It stopped without saying why.';
}
