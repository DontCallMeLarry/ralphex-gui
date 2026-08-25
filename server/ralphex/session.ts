/**
 * One ralphex process, watched from the glass.
 *
 * Two rules shape this. Output is never lost: every line is recorded in order
 * and replayed to a browser that joins late or reloads. And nothing that
 * reaches the page is terminal output — a question ralphex asks is drawn as the
 * question and its choices, a failure is a sentence, and its own chatter is
 * folded machinery, the same way the Terrarium already folds a run of tool
 * calls.
 *
 * Both places Terrarium drives ralphex — the interview a sprout starts, and the
 * loop the tending bench runs — are this class. The difference is the argv and
 * what happens after the process leaves.
 */
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Response } from 'express';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyLine, createLineSplitter, type Level, type Phase } from './phases.ts';
import {
  isMachineryNoise,
  pendingQuestion,
  proposedPlan,
  whyItStopped,
  type DraftReview,
  type PendingQuestion,
  type ReadoutEvent,
} from './readout.ts';
import { parsePlan } from './plan.ts';
import { resolvePlanPath } from './plans.ts';
import { parseSection, type Section } from './usage/stages.ts';
import { UsageMeter, type UsageReport } from './usage/meter.ts';
import { buildCommand, type RunOptions } from './command.ts';

export type SessionStatus =
  | 'starting'
  | 'running'
  /** The process is blocked on a numbered picker; the page has the card. */
  | 'asking'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  /** Wrapped up by the developer — potted, or the bench closed. */
  | 'closed';

export type RalphexEventType =
  | 'status'
  | 'notice'
  | 'user_text'
  | 'line'
  | 'stage'
  | 'plan'
  /** A drafted plan is waiting on the flow's own two buttons. */
  | 'review'
  | 'ready'
  | 'question'
  | 'question_closed'
  | 'usage'
  | 'progress'
  | 'session_error'
  | 'done';

export interface RalphexEvent {
  seq: number;
  type: RalphexEventType;
  data: Record<string, unknown>;
}

/** The question card's shape, the same one the Terrarium has always drawn. */
export interface CardQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

const CANCEL_TERM_MS = 8_000;
const CANCEL_KILL_MS = 20_000;
/** Long enough for ralphex to finish printing a picker before we read it. */
const QUESTION_SETTLE_MS = 250;
/** How long the picker gets to accept "type your own answer" before the words. */
const OTHER_HANDOFF_MS = 1_200;
const USAGE_POLL_MS = 4_000;

export interface SessionSpec {
  /** Where ralphex runs. For a sprout that is the repo; for a run, the worktree. */
  cwd: string;
  /** The ralphex binary. */
  bin: string;
  options: RunOptions;
  /** A word for the log, e.g. "interview" or "grow". */
  what: string;
  /** Directories whose Claude Code transcripts belong to this run. */
  meterDirs?: string[];
  /**
   * Where this repo keeps plan files. Set for an interview, so a plan ralphex
   * names rather than prints can still be read and shown.
   */
  plansDir?: string;
  /**
   * Terrarium's own folder for plan files. A plan that was only printed is
   * written here, so the plan is always a markdown document to open rather than
   * something to go looking for in scrollback.
   */
  planCacheDir?: string;
  /** Run after the process leaves cleanly; its throw becomes the failure. */
  afterExit?: (session: RalphexSession) => Promise<void>;
  /** Polled while running, for anything that changes on disk under the run. */
  poll?: (session: RalphexSession) => Promise<Record<string, unknown> | null>;
}

export class RalphexSession {
  readonly id = randomUUID();
  readonly cwd: string;
  readonly what: string;
  readonly startedAt = new Date().toISOString();
  endedAt: string | null = null;
  status: SessionStatus = 'starting';
  exitCode: number | null = null;
  /** The sentence a failure is reported as, once there is one. */
  error: string | null = null;

  #spec: SessionSpec;
  #events: RalphexEvent[] = [];
  /** The subset of events `readout` reads: ralphex's lines and our answers. */
  #readout: ReadoutEvent[] = [];
  #subscribers = new Set<Response>();
  #child: ChildProcess | null = null;
  #phase: Phase = 'setup';
  /** The last stage boundary ralphex printed, so a question can say who asked. */
  #stage: Section | null = null;
  #cancelling = false;
  #timers: NodeJS.Timeout[] = [];
  #settle: NodeJS.Timeout | null = null;
  #usageTimer: NodeJS.Timeout | null = null;
  #pollTimer: NodeJS.Timeout | null = null;
  #meter: UsageMeter;
  #usage: UsageReport | null = null;
  #askedSeq = 0;
  /** The plan already on screen, so an unchanged one is not redrawn. */
  #shownPlan = '';
  /** The draft the developer took, kept in case ralphex never writes it out. */
  #taken = '';
  #pending: { requestId: string; question: PendingQuestion } | null = null;
  /** ralphex waiting to be told what to do with the plan it has drafted. */
  #review: DraftReview | null = null;
  /** Words a picker refused because it wanted a number; offered back to the card. */
  #prefill = '';
  /** Set once the session has produced what it was started for. */
  #ready = false;
  #exited: Promise<void>;
  #markExited: () => void = () => {};

  constructor(spec: SessionSpec) {
    this.#spec = spec;
    this.cwd = spec.cwd;
    this.what = spec.what;
    this.#meter = new UsageMeter(spec.meterDirs ?? [spec.cwd]);
    this.#exited = new Promise<void>((resolve) => {
      this.#markExited = resolve;
    });
  }

  get events(): RalphexEvent[] {
    return this.#events;
  }

  get usage(): UsageReport | null {
    return this.#usage;
  }

  get live(): boolean {
    return this.status === 'running' || this.status === 'asking' || this.status === 'starting';
  }

  #log(line: string): void {
    console.log(`🌱 [${this.id.slice(0, 8)} ${this.what}] ${line}`);
  }

  // ------------------------------------------------------------------ start

  start(): void {
    const built = buildCommand({ ...this.#spec.options, bin: this.#spec.bin });
    if (!built.launchable) {
      this.#fail(built.errors.join(' '));
      return;
    }
    this.#log(`${built.display} in ${this.cwd}`);
    let child: ChildProcess;
    try {
      child = spawn(built.bin, built.args, {
        cwd: this.cwd,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' },
        // stdin is piped, not ignored: the interview asks questions, and those
        // answers arrive from the browser.
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group, so cancelling reaches the claude processes ralphex
        // spawns rather than only ralphex itself.
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (err) {
      this.#fail(`Could not start ${built.bin}: ${(err as Error).message}`);
      return;
    }

    this.#child = child;
    this.#setStatus('running');

    this.#attach(child.stdout, 'stdout');
    this.#attach(child.stderr, 'stderr');

    child.on('error', (err: NodeJS.ErrnoException) => {
      const message =
        err.code === 'ENOENT'
          ? `${built.bin} is not installed or not on PATH.`
          : err.message;
      this.error ??= message;
      this.#record('system', message, 'error');
    });
    // A child that exits before we write kills the pipe; that is not a crash.
    child.stdin?.on('error', () => {});
    child.on('close', (code) => void this.#finish(code));

    this.#usageTimer = setInterval(() => this.#readUsage(), USAGE_POLL_MS);
    this.#usageTimer.unref?.();
    if (this.#spec.poll) {
      this.#pollTimer = setInterval(() => void this.#pollOnce(), 5_000);
      this.#pollTimer.unref?.();
      void this.#pollOnce();
    }
  }

  #attach(stream: NodeJS.ReadableStream | null, name: 'stdout' | 'stderr'): void {
    if (!stream) return;
    stream.setEncoding('utf8');
    const splitter = createLineSplitter((line) => this.#record(name, line));
    stream.on('data', (chunk: string) => splitter.push(chunk));
    stream.on('end', () => splitter.flush());
  }

  // ------------------------------------------------------------------ lines

  #record(stream: string, text: string, forced?: Level): void {
    const classified = classifyLine(text, this.#phase);
    this.#phase = classified.phase;
    // ralphex spaces its output out with blank lines. On a terminal that is
    // breathing room; in a folded run of lines it is an empty grey row.
    if (!classified.text.trim()) return;
    const level = forced ?? (stream === 'stderr' && classified.level === 'info' ? 'warn' : classified.level);

    // A section header is a chapter break, not a line of machinery: it is what
    // ralphex says it is doing next, and the transcript draws it as a rule.
    const section = parseSection(classified.text, classified.phase);
    if (section) this.#stage = section;
    const event = section
      ? this.#emit('stage', { label: section.label, kind: section.kind, index: section.index })
      : this.#emit('line', {
          stream,
          text: classified.text,
          phase: classified.phase,
          level,
          marker: classified.marker?.label ?? null,
          // The progress log's stamped copy of what the terminal already said,
          // and the protocol labels around a picker. Recorded, never in the flow.
          noise: isMachineryNoise(classified.text),
        });

    this.#readout.push({ seq: event.seq, stream, text: classified.text, level });
    if (level === 'error' && !this.error) this.error = classified.text;
    this.#scheduleQuestionCheck();
  }

  /**
   * ralphex prints a question, then its options, then blocks on stdin. There is
   * no marker for "now waiting", so the transcript is re-read a beat after it
   * stops growing.
   */
  #scheduleQuestionCheck(): void {
    if (this.#settle) clearTimeout(this.#settle);
    this.#settle = setTimeout(() => {
      this.#settle = null;
      // The plan first: ralphex prints it and then asks whether to keep it, so
      // by the time the question card appears the plan is already above it.
      this.#checkForPlan();
      this.#checkForQuestion();
    }, QUESTION_SETTLE_MS);
    this.#settle.unref?.();
  }

  #checkForQuestion(): void {
    if (!this.live) return;
    const question = pendingQuestion(this.#readout);
    if (!question || question.seq <= this.#askedSeq) return;
    this.#askedSeq = question.seq;

    // The draft review is not a question, whatever it looks like on a
    // terminal. Two of its four answers cannot happen through a browser at all
    // — one opens an editor, one throws the plan away — and the other two are
    // the two things the flow already offers: send the plan back with what is
    // wrong with it, or sprout it, which is the accepting. So it is held here
    // for those two buttons to answer, and no card is drawn.
    if (question.review) {
      this.#review = question.review;
      this.#log('draft review open: waiting on sprout or feedback');
      this.#emit('review', { open: true });
      this.#setStatus('asking');
      return;
    }

    const requestId = randomUUID();
    this.#pending = { requestId, question };
    this.#log(`asking: ${question.question.slice(0, 90)}`);
    this.#emit('question', {
      requestId,
      questions: [toCard(question)],
      prefill: this.#prefill,
      // Which stage of the loop is doing the asking. A question arriving out of
      // nowhere mid-run is the loop stopping for no reason anybody can see;
      // named, it is the review wanting a word.
      stage: this.#stage ? { kind: this.#stage.kind, index: this.#stage.index, label: this.#stage.label } : null,
      // The lines the picker was drawn from. The card *is* the question, so the
      // terminal's own rendering of it is not shown a second time as machinery.
      drawnFrom: [question.askedAt || question.from, question.seq],
    });
    this.#prefill = '';
    this.#setStatus('asking');
  }

  /**
   * The plan ralphex is asking about.
   *
   * It prints the plan and then asks whether to keep it. Every line it printed
   * is folded machinery here, so without this the question would be "keep it?"
   * with the it nowhere on screen — approving something you cannot see, which
   * is the one thing the glass must never ask for.
   */
  #checkForPlan(): void {
    if (!this.#spec.plansDir) return;
    const found = proposedPlan(this.#readout);
    if (!found) return;

    let markdown = found.text;
    if (!markdown && found.path) {
      // Named before it was written: the file appears a moment later, and the
      // next settle picks it up.
      const file = resolvePlanPath(this.cwd, this.#spec.plansDir, found.path);
      if (!file || !existsSync(file)) return;
      try {
        markdown = readFileSync(file, 'utf8');
      } catch {
        return;
      }
    }
    if (!markdown.trim() || markdown === this.#shownPlan) return;
    this.#shownPlan = markdown;

    const analysis = parsePlan(markdown);
    this.#log(`plan on the table: ${analysis.title ?? found.title ?? '(untitled)'}`);
    this.#emit('plan', {
      title: analysis.title ?? found.title,
      path: found.path ?? this.#cachePlan(markdown),
      markdown,
      // The lines it was printed on. The card is the plan; the terminal's own
      // rendering of it is not shown underneath as machinery too.
      drawnFrom: found.drawnFrom,
      progress: analysis.progress,
      tasks: analysis.tasks.map((task) => ({
        kind: task.kind,
        number: task.number,
        description: task.description,
        done: task.done,
        total: task.total,
      })),
      problems: analysis.diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => `line ${d.line}: ${d.message}`),
    });
  }

  /**
   * A plan that was only printed, written out as a markdown file.
   *
   * Reading a plan means opening a document, never scrolling back through
   * output looking for where it started — so whatever ralphex does, there is a
   * file. Failing to write one costs the path and nothing else.
   */
  #cachePlan(markdown: string): string | null {
    const dir = this.#spec.planCacheDir;
    if (!dir) return null;
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${this.id}.md`);
      writeFileSync(file, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
      return file;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ ready

  /**
   * The session has produced what it was started for, whatever the process
   * does next. An interview that has written its plan is done as far as
   * Terrarium is concerned, even while it is still offering to do more.
   */
  signalReady(data: Record<string, unknown> = {}): void {
    if (this.#ready) return;
    this.#ready = true;
    this.#emit('ready', data);
  }

  get isReady(): boolean {
    return this.#ready;
  }

  /** Resolves when the process has left and its after-work has settled. */
  whenExited(): Promise<void> {
    return this.#exited;
  }

  // ---------------------------------------------------------------- answers

  /**
   * Answer the open question. A picked option goes back as its number, which is
   * all the picker ever wanted. Words go back the way a person would type them
   * at the terminal: the number of the "type your own answer" option, then the
   * words — unless the picker turns out to have asked something else in
   * between, and then the words come back to the card unsent.
   */
  answer(requestId: string, value: string | string[]): boolean {
    const pending = this.#pending;
    if (!pending || pending.requestId !== requestId) return false;
    const picks = Array.isArray(value) ? value : [value];
    const options = pending.question.options;

    const matched = picks
      .map((pick) => options.find((option) => option.label === pick))
      .find((option) => option && !option.other);
    const typed = picks.find((pick) => !options.some((option) => option.label === pick))?.trim();

    this.#pending = null;
    this.#emit('question_closed', { requestId });

    if (matched && !typed) {
      this.#send(String(matched.number), matched.label);
      return true;
    }

    const words = typed || matched?.label || '';
    if (!words) return true;

    const other = options.find((option) => option.other);
    if (!other) {
      this.#send(words, words);
      return true;
    }
    this.#send(String(other.number), words);
    const asked = pending.question.seq;
    const timer = setTimeout(() => {
      const next = pendingQuestion(this.#readout);
      if (next && next.seq !== asked && next.options.length) {
        // It asked something else instead. Hold the words rather than firing
        // them into a picker that is counting.
        this.#prefill = words;
        this.#emit('notice', { level: 'warn', text: 'That picker wanted a number, so your words are still unsent.' });
        this.#checkForQuestion();
        return;
      }
      this.#write(words);
    }, OTHER_HANDOFF_MS);
    timer.unref?.();
    this.#timers.push(timer);
    return true;
  }

  /** A line typed into the reply box with no question open. */
  say(text: string): void {
    const line = String(text ?? '').trim();
    if (!line) return;
    if (!this.live) throw new Error(`This session is ${this.status}.`);
    if (this.#review) {
      this.reviseDraft(line);
      return;
    }
    if (this.#pending) {
      const { requestId } = this.#pending;
      this.answer(requestId, line);
      return;
    }
    this.#send(line, line);
  }

  /**
   * The plan the developer took, as markdown, or empty. It is the document
   * that was on the screen the moment they took it — which is the whole of
   * approving one, so it is owed a file whatever the interview does next.
   */
  get takenPlan(): string {
    return this.#taken;
  }

  /** Is there a drafted plan waiting to be told what to do with it? */
  get isReviewingDraft(): boolean {
    return this.#review !== null;
  }

  /**
   * Take the drafted plan. This is the whole of approving it: ralphex writes
   * the file next, and the file is what a seedling is grown from — so the
   * button that says it is doing that is the one that says "sprout it", and
   * there is no second one that only agrees.
   */
  acceptDraft(): boolean {
    const review = this.#review;
    if (!review || !this.live) return false;
    this.#review = null;
    this.#emit('review', { open: false });
    // What was on the screen when the button was pressed. ralphex hands the
    // writing of the file to a model, and a model that leaves without doing it
    // would otherwise take the approved plan with it.
    this.#taken = this.#shownPlan;
    this.#write(String(review.accept));
    this.#recordInput('accept', 'Taking this plan — writing it out.');
    this.#setStatus('running');
    return true;
  }

  /**
   * Say what is wrong with the drafted plan. ralphex asks for the words on the
   * line after the number, from the same reader, so both go now — a picker
   * that has already read the number is not waiting on anything else.
   */
  reviseDraft(feedback: string): boolean {
    const review = this.#review;
    const words = String(feedback ?? '').trim();
    if (!review || !words || !this.live) return false;
    this.#review = null;
    this.#emit('review', { open: false });
    // Sending it back un-takes it: the plan that comes next is the one to keep.
    this.#taken = '';
    this.#write(String(review.revise));
    this.#write(words);
    this.#recordInput(words, words, 'you');
    this.#setStatus('running');
    return true;
  }

  /**
   * Put an answer we sent into the transcript. `readout` needs it to know the
   * picker has been answered; the flow needs to see what was said, either in
   * the developer's words or in Terrarium's.
   */
  #recordInput(sent: string, shown: string, voice: 'you' | 'terrarium' = 'terrarium'): void {
    const event =
      voice === 'you'
        ? this.#emit('user_text', { text: shown })
        : this.#emit('notice', { level: 'info', text: shown });
    this.#readout.push({ seq: event.seq, stream: 'input', text: sent });
  }

  /** Write a line to ralphex and show the developer what was said on their behalf. */
  #send(line: string, shown: string): void {
    this.#write(line);
    this.#recordInput(shown, shown, 'you');
    if (this.status === 'asking') this.#setStatus('running');
  }

  #write(line: string): void {
    const stdin = this.#child?.stdin;
    if (!stdin || stdin.destroyed) {
      this.#emit('notice', { level: 'warn', text: 'That run is no longer accepting input.' });
      return;
    }
    stdin.write(`${String(line).replace(/[\r\n]+$/, '')}\n`);
  }

  // ------------------------------------------------------------------- exit

  async #finish(code: number | null): Promise<void> {
    this.#clearTimers();
    this.exitCode = code;
    this.endedAt = new Date().toISOString();
    this.#readUsage();

    if (this.#cancelling) {
      this.#setStatus('cancelled');
    } else if (code === 0) {
      this.#setStatus('running'); // still ours until the after-work lands
      try {
        await this.#spec.afterExit?.(this);
        this.#setStatus('succeeded');
      } catch (err) {
        this.#fail((err as Error).message);
        return;
      }
    } else {
      this.#setStatus('failed');
    }

    if (this.status === 'failed' || this.status === 'cancelled') {
      const sentence = whyItStopped({ status: this.status, error: this.error }, this.#readout);
      if (sentence) this.#emit('session_error', { message: sentence });
    }
    await this.#pollOnce();
    this.#readUsage();
    this.#emit('done', { status: this.status, exitCode: code });
    this.#log(`${this.status}${code === null ? '' : ` (exit ${code})`}`);
    this.#markExited();
  }

  #fail(message: string): void {
    this.error ??= message;
    this.endedAt ??= new Date().toISOString();
    this.#setStatus('failed');
    this.#emit('session_error', { message });
    // Every session ends with `done`, however it ended: a page that never sees
    // one is a page still waiting.
    this.#emit('done', { status: this.status, exitCode: this.exitCode });
    this.#clearTimers();
    this.#markExited();
  }

  /** SIGINT, then SIGTERM, then SIGKILL — giving ralphex a chance to tidy up. */
  cancel(): void {
    if (!this.live || this.#cancelling) return;
    this.#cancelling = true;
    this.#emit('notice', { level: 'warn', text: 'Stopping — asking ralphex to wind up.' });
    this.#signal('SIGINT');
    this.#later(() => {
      this.#emit('notice', { level: 'warn', text: 'Still going after 8s: sending SIGTERM.' });
      this.#signal('SIGTERM');
    }, CANCEL_TERM_MS);
    this.#later(() => {
      this.#emit('notice', { level: 'error', text: 'Still going after 20s: sending SIGKILL.' });
      this.#signal('SIGKILL');
    }, CANCEL_KILL_MS);
  }

  /** The developer is done with this session; stop everything and let go. */
  close(): void {
    if (this.live) this.cancel();
    this.#setStatus('closed');
    this.#clearTimers();
    for (const res of this.#subscribers) res.end();
    this.#subscribers.clear();
  }

  #later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      if (this.live) fn();
    }, ms);
    timer.unref?.();
    this.#timers.push(timer);
  }

  #signal(signal: NodeJS.Signals): void {
    const child = this.#child;
    if (!child || child.exitCode !== null) return;
    try {
      // Negative pid targets the whole process group.
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }

  #clearTimers(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers = [];
    if (this.#settle) clearTimeout(this.#settle);
    this.#settle = null;
    if (this.#usageTimer) clearInterval(this.#usageTimer);
    this.#usageTimer = null;
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = null;
  }

  // --------------------------------------------------------- usage and poll

  #readUsage(): void {
    try {
      const report = this.#meter.read(
        this.#events
          .filter((e) => e.type === 'line' || e.type === 'stage')
          .map((e) => ({
            ts: (e.data.ts as number) ?? Date.now(),
            phase: (e.data.phase as string) ?? 'setup',
            text: e.type === 'stage' ? `--- ${String(e.data.label)} ---` : String(e.data.text ?? ''),
          })),
        { startedAt: this.startedAt, endedAt: this.endedAt, live: this.live },
      );
      const before = this.#usage?.totals.total ?? -1;
      this.#usage = report;
      if (report.totals.total !== before) this.#emit('usage', { report });
    } catch {
      // Measurement is never load-bearing: a run is not worse for being unmeasured.
    }
  }

  async #pollOnce(): Promise<void> {
    if (!this.#spec.poll) return;
    try {
      const data = await this.#spec.poll(this);
      if (data) this.#emit('progress', data);
    } catch {
      /* the plan file may be mid-write, or moved; the next poll settles it */
    }
  }

  // ------------------------------------------------------------------ wires

  #setStatus(status: SessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.#emit('status', { status });
  }

  #emit(type: RalphexEventType, data: Record<string, unknown>): RalphexEvent {
    const event: RalphexEvent = { seq: this.#events.length, type, data: { ts: Date.now(), ...data } };
    this.#events.push(event);
    for (const res of this.#subscribers) writeSse(res, event);
    return event;
  }

  /** SSE with full replay, so a reloaded page recovers the whole session. */
  subscribe(res: Response): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    for (const event of this.#events) writeSse(res, event);
    this.#subscribers.add(res);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    heartbeat.unref?.();
    res.on('close', () => {
      clearInterval(heartbeat);
      this.#subscribers.delete(res);
    });
  }

  /** Say something in the transcript in Terrarium's own voice. */
  note(text: string, level: 'info' | 'warn' = 'info'): void {
    this.#emit('notice', { level, text });
  }
}

/**
 * A numbered picker, as the question card draws it. The "type your own answer"
 * option is dropped: the card already has a box for that, and offering it twice
 * makes the escape hatch look like a choice.
 */
function toCard(question: PendingQuestion): CardQuestion {
  return {
    question: question.question,
    header: 'ralphex',
    options: question.options
      .filter((option) => !option.other)
      .map((option) => ({ label: option.label, description: '' })),
    multiSelect: false,
  };
}

function writeSse(res: Response, event: RalphexEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
