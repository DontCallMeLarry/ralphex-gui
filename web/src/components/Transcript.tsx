import { useEffect, useMemo, useRef, useState } from 'react';
import {
  duration,
  money,
  tokens as fmtTokens,
  type PlanProgress,
  type PlanTask,
  type ProposedPlan,
  type Question,
  type RalphexEvent,
  type SessionStatus,
  type UsageReport,
} from '../api.ts';
import { growthOf, whoIsAsking } from '../growth.ts';
import { Markdown } from '../markdown.tsx';
import { Overlay } from './Overlay.tsx';

/**
 * Everything that watches a run, shared by the two places that do: the
 * interview a sprout starts, and the loop the tending bench runs.
 *
 * The rule the whole file follows is the one the glass follows everywhere: none
 * of this is terminal output. A question is drawn as the question and its
 * choices, a plan is a document you open, a failure is a sentence. The output
 * underneath all three is machinery — kept, because a run that goes wrong has
 * to be readable, and out of the flow, because nobody watching it work should
 * have to read a log to find the one sentence addressed to them.
 *
 * Its own count of the passes it has made is not addressed to anyone either.
 * It is a number that goes up, so it is a small counter at the end of the line
 * that says what it is doing, and nothing else in the flow moves for it.
 */

export interface ProgressData {
  file: string | null;
  progress: PlanProgress;
  tasks: PlanTask[];
}

export interface PendingAsk {
  requestId: string;
  questions: Question[];
  /** Words a picker refused because it wanted a number, offered back. */
  prefill: string;
  /** Which part of the loop asked, in a few words, or null before it has said. */
  asking: string | null;
}

export interface SessionState {
  events: RalphexEvent[];
  status: SessionStatus;
  usage: UsageReport | null;
  progress: ProgressData | null;
  /** The plan on the table, when there is one. */
  plan: ProposedPlan | null;
  /**
   * The plan is up for a decision: ralphex has drafted it and is waiting to be
   * told what to do with it. False again the moment it is told, which is what
   * makes "sent it back" and "here is the new one" two different screens.
   */
  reviewing: boolean;
  /**
   * It has produced what it was started for — for an interview, the plan file.
   * True long before the process leaves, which is the point: the seedling is
   * real from here on, whatever the conversation does next.
   */
  ready: boolean;
  /** The live feed dropped; EventSource is reconnecting and will replay. */
  streamDown: boolean;
  live: boolean;
  ended: boolean;
  pending: PendingAsk | null;
}

const IDLE: SessionState = {
  events: [],
  status: 'starting',
  usage: null,
  progress: null,
  plan: null,
  reviewing: false,
  ready: false,
  streamDown: false,
  live: false,
  ended: false,
  pending: null,
};

/**
 * Follow one session. The server replays the whole transcript on connect, so a
 * reload, a reconnect or a late join all land in the same place.
 */
export function useSessionStream(sessionId: string | null, kind: 'sprout' | 'bench'): SessionState {
  const [events, setEvents] = useState<RalphexEvent[]>([]);
  const [status, setStatus] = useState<SessionStatus>('starting');
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [plan, setPlan] = useState<ProposedPlan | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [ready, setReady] = useState(false);
  const [streamDown, setStreamDown] = useState(false);
  const seen = useRef(new Set<number>());

  useEffect(() => {
    if (!sessionId) return;
    seen.current = new Set();
    setEvents([]);
    setStatus('starting');
    setPlan(null);
    setReviewing(false);
    setReady(false);
    // A different session is a different run. Carrying the last one's progress
    // over would have a fresh run open claiming the plan it has not touched yet
    // is finished, and its price start at what the previous one spent.
    setProgress(null);
    setUsage(null);
    const source = new EventSource(`/api/${kind === 'sprout' ? 'sprout' : 'bench'}/${sessionId}/events`);
    source.onopen = () => setStreamDown(false);
    // EventSource retries on its own and the server replays everything on
    // reconnect, so this only has to make the gap visible.
    source.onerror = () => setStreamDown(true);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as RalphexEvent;
      if (seen.current.has(event.seq)) return;
      seen.current.add(event.seq);
      if (event.type === 'status') setStatus(event.data.status as SessionStatus);
      if (event.type === 'done') setStatus(event.data.status as SessionStatus);
      if (event.type === 'usage') setUsage(event.data.report as UsageReport);
      if (event.type === 'progress') setProgress(event.data as unknown as ProgressData);
      if (event.type === 'plan') setPlan(event.data as unknown as ProposedPlan);
      if (event.type === 'review') setReviewing(event.data.open === true);
      if (event.type === 'ready') setReady(true);
      setEvents((prev) => [...prev, event].sort((a, b) => a.seq - b.seq));
    };
    return () => source.close();
  }, [sessionId, kind]);

  const pending = useMemo(() => findPending(events), [events]);
  if (!sessionId) return IDLE;

  return {
    events,
    status,
    usage,
    progress,
    plan,
    reviewing,
    ready,
    streamDown,
    live: status === 'starting' || status === 'running' || status === 'asking',
    ended: status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'closed',
    pending,
  };
}

function findPending(events: RalphexEvent[]): PendingAsk | null {
  const closed = new Set(events.filter((e) => e.type === 'question_closed').map((e) => String(e.data.requestId)));
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type === 'question' && !closed.has(String(event.data.requestId))) {
      return {
        requestId: String(event.data.requestId),
        questions: (event.data.questions as Question[]) ?? [],
        prefill: String(event.data.prefill ?? ''),
        asking: whoIsAsking(event.data.stage),
      };
    }
  }
  return null;
}

// -- the transcript -----------------------------------------------------------

export function Transcript({
  state,
  working,
  onAnswer,
}: {
  state: SessionState;
  /** What to say while it is thinking and has not asked anything. */
  working: string;
  onAnswer: (requestId: string, answers: Record<string, string | string[]>) => Promise<void>;
}) {
  const [elapsed, setElapsed] = useState(0);
  const [details, setDetails] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => groupRows(state.events), [state.events]);
  const machinery = useMemo(() => state.events.filter((event) => event.type === 'line'), [state.events]);
  const growth = useMemo(() => growthOf(state.events), [state.events]);
  const pending = state.pending;

  // The tail is the only place worth being. Anyone reading this is waiting on
  // the next thing it says, so it follows — and there is no button offering to
  // put them back where they already are.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // `details` is in here because opening it takes height off the transcript,
    // and what falls off the bottom is the newest thing it said.
  }, [rows.length, pending, state.live, details]);

  // A long stretch with no output of its own looks identical to a wedged one.
  // The clock is read off the run's first event, not off this component: the
  // bench can be closed and opened again over a run that never stopped, and a
  // counter that restarted at zero each time would be measuring the wrong
  // thing — how long you had been watching, not how long it had been going.
  const startedAt = growth.startedAt;
  useEffect(() => {
    if (!state.live || startedAt === null) return;
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [state.live, startedAt]);

  return (
    <div className="sprout-stream">
      <div className="sprout-transcript" ref={scrollRef}>
        {rows.map((event) => (
          <Row key={event.seq} event={event} pending={pending} onAnswer={onAnswer} />
        ))}
        {state.live && (
          <div className="thinking">
            <span className="thinking-dots">
              <i />
              <i />
              <i />
            </span>
            {/* The phase said outright, then the same thing said the way the
                rest of the terrarium talks. Both, because a run that is still
                going with every box ticked has to be able to say why. */}
            {!pending && growth.phase && <span className="thinking-phase">{growth.phase}</span>}
            <span className="thinking-what">
              {pending
                ? 'Waiting on your answer above'
                : `${growth.doing ?? working}${growth.detail ? ` — ${growth.detail}` : ''} · ${duration(elapsed)}`}
            </span>
            {/* The ticker: it goes up, and that is all it does. */}
            {growth.pass !== null && !pending && (
              <span className="pass-tick" title="How many times round the loop it has been">
                pass {growth.pass}
              </span>
            )}
          </div>
        )}
      </div>
      {machinery.length > 0 && (
        <div className={`machinery${details ? ' open' : ''}`}>
          <button className="machinery-toggle" type="button" onClick={() => setDetails(!details)}>
            {details ? '▾ hide technical details' : `▸ technical details (${machinery.length} lines)`}
          </button>
          {details && (
            <div className="machinery-lines">
              {machinery.map((event) => (
                <OutputLine key={event.seq} event={event} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * What the flow never draws.
 *
 * Everything ralphex printed, first of all. The page's one rule is that
 * nothing on it is terminal output, and a run of grey lines down the middle is
 * terminal output whatever it is folded into — the card above is the question
 * said properly, the plan is a document, a failure is a sentence, and the raw
 * lines behind all three are one click away under technical details.
 *
 * Then the events the screen around the flow is already showing: the plan, the
 * progress, the price, the state it is in. And last, the loop's own count of
 * where it has got to — "task iteration 3" is the loop talking to itself, and
 * a rule drawn across the page for each one turns watching the work into
 * reading a log of it. That has one home instead: the line saying what is
 * happening, and the counter at the end of it.
 */
const OUT_OF_FLOW = new Set(['line', 'usage', 'progress', 'plan', 'review', 'ready', 'status', 'stage']);

/** What is left, which is the conversation. */
function groupRows(events: RalphexEvent[]): RalphexEvent[] {
  return events.filter((event) => !OUT_OF_FLOW.has(event.type));
}

function Row({
  event,
  pending,
  onAnswer,
}: {
  event: RalphexEvent;
  pending: PendingAsk | null;
  onAnswer: (requestId: string, answers: Record<string, string | string[]>) => Promise<void>;
}) {
  switch (event.type) {
    case 'user_text':
      return <Message who="you" text={String(event.data.text)} mine />;
    case 'notice':
      return (
        <div className={event.data.level === 'warn' || event.data.level === 'error' ? 'notice-line warn-line' : 'notice-line'}>
          {String(event.data.text)}
        </div>
      );
    case 'question': {
      const requestId = String(event.data.requestId);
      if (!pending || pending.requestId !== requestId) {
        // Answered. The card goes, but the question stays: the picker's own
        // lines are hidden, so this is the only record of what was asked.
        const asked = (event.data.questions as Question[])?.[0]?.question ?? 'answered';
        return <div className="notice-line">✅ {asked}</div>;
      }
      return (
        <QuestionCard
          requestId={requestId}
          questions={pending.questions}
          prefill={pending.prefill}
          asking={pending.asking}
          onAnswer={onAnswer}
        />
      );
    }
    case 'session_error':
      return <Message who="it stopped" text={String(event.data.message)} tone="error" />;
    case 'done':
      return (
        <div className="turn-rule ended">
          <span>{ENDINGS[String(event.data.status)] ?? 'it stopped'}</span>
        </div>
      );
    default:
      return null;
  }
}

/** How a run ends, in the terrarium's words rather than the process's. */
const ENDINGS: Record<string, string> = {
  succeeded: '🌾 all grown',
  failed: '✖ it stopped',
  cancelled: '⏸ you stopped it',
  closed: '🪴 potted',
};

/** A message runs to the clamp and then stops; the rest is a click away. */
const CLAMP_PX = 360;

function Message({
  who,
  text,
  mine = false,
  tone,
}: {
  who: string;
  text: string;
  mine?: boolean;
  tone?: 'error';
}) {
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = body.current;
    if (el) setLong(el.scrollHeight > CLAMP_PX + 60);
  }, [text]);

  return (
    <div className={`msg ${tone ?? (mine ? 'mine' : 'pipeline')}`}>
      <div className="msg-who">{who}</div>
      <div className={`msg-body${long && !open ? ' clipped' : ''}`} ref={body}>
        <Markdown text={text} />
      </div>
      {long && (
        <button className="msg-more" type="button" onClick={() => setOpen(!open)}>
          {open ? 'fold this back up' : 'read the whole thing'}
        </button>
      )}
    </div>
  );
}

function OutputLine({ event }: { event: RalphexEvent }) {
  const text = String(event.data.text ?? '');
  const level = String(event.data.level ?? 'info');
  return (
    <div className={`tool-line line-${level}`} title={text}>
      <span className="tool-summary">{text}</span>
    </div>
  );
}

/**
 * One question it asked. It asks in a terminal — a numbered list to type a
 * number into — and none of that belongs here: this is the sentence, the
 * choices as buttons, and a box for answering in your own words instead.
 */
export function QuestionCard({
  requestId,
  questions,
  prefill,
  asking,
  onAnswer,
}: {
  requestId: string;
  questions: Question[];
  prefill?: string;
  /** Which part of the loop stopped to ask, when it was one that says. */
  asking?: string | null;
  onAnswer: (requestId: string, answers: Record<string, string | string[]>) => Promise<void>;
}) {
  const [selected, setSelected] = useState<Record<number, Set<string>>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);

  // Words a picker refused because it wanted a number come back to the box they
  // were typed in, rather than being lost between two questions.
  useEffect(() => {
    if (prefill) setCustom((prev) => ({ ...prev, 0: prefill }));
  }, [prefill]);

  function toggle(qi: number, label: string, multi: boolean) {
    setSelected((prev) => {
      const next = { ...prev };
      const set = new Set(next[qi] ?? []);
      if (set.has(label)) set.delete(label);
      else {
        if (!multi) set.clear();
        set.add(label);
      }
      next[qi] = set;
      return next;
    });
  }

  function answerFor(qi: number, q: Question): string | string[] | null {
    const text = (custom[qi] ?? '').trim();
    const picks = [...(selected[qi] ?? [])];
    if (text) return picks.length > 0 ? [...picks, text] : text;
    if (picks.length === 0) return null;
    return q.multiSelect ? picks : picks[0];
  }

  const complete = questions.every((q, qi) => answerFor(qi, q) !== null);

  async function submit() {
    setBusy(true);
    const answers: Record<string, string | string[]> = {};
    questions.forEach((q, qi) => {
      const a = answerFor(qi, q);
      if (a !== null) answers[q.question] = a;
    });
    await onAnswer(requestId, answers);
  }

  /** A single choice needs no second click: picking it is the answer. */
  async function pickAndSend(q: Question, label: string) {
    setBusy(true);
    await onAnswer(requestId, { [q.question]: label });
  }

  return (
    <div className="question-card">
      {/* Who stopped to ask. A question landing in the middle of a run reads as
          the loop breaking down until it says which part of the loop wants a
          word — the review, on its second pass, about what it found. */}
      {asking && <div className="question-from">{asking}</div>}
      {questions.map((q, qi) => (
        <div key={qi} className="question">
          <div className="question-text">{q.question}</div>
          <div className="options">
            {q.options.map((opt) => (
              <button
                key={opt.label}
                className={`option ${selected[qi]?.has(opt.label) ? 'selected' : ''}`}
                onClick={() =>
                  questions.length === 1 && !q.multiSelect && !(custom[qi] ?? '').trim()
                    ? void pickAndSend(q, opt.label)
                    : toggle(qi, opt.label, q.multiSelect)
                }
                disabled={busy}
                title={opt.description || undefined}
                type="button"
              >
                <span className="option-label">{opt.label}</span>
                {opt.description && <span className="option-desc">{opt.description}</span>}
              </button>
            ))}
          </div>
          <input
            className="option-other"
            placeholder="or answer in your own words"
            value={custom[qi] ?? ''}
            onChange={(e) => setCustom((prev) => ({ ...prev, [qi]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && complete && !busy) void submit();
            }}
          />
        </div>
      ))}
      {(questions.length > 1 || questions.some((q, qi) => q.multiSelect || (custom[qi] ?? '').trim())) && (
        <div className="dialog-actions">
          <button className="btn primary" onClick={submit} disabled={!complete || busy}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      )}
    </div>
  );
}

// -- the plan on the table ----------------------------------------------------

/**
 * The plan, as the thing the screen is about.
 *
 * By the time there is a plan, it is the only thing worth looking at, so it
 * gets the room: what it is called, and every task it is made of. That much is
 * always showing — being asked to approve a plan you cannot see is the one
 * thing the glass must not do — and the whole document is one button away,
 * rendered, rather than somewhere back up the output.
 */
export function PlanCard({ plan }: { plan: ProposedPlan }) {
  const [reading, setReading] = useState(false);
  const steps = plan.progress.checkboxes.total;

  return (
    <div className="proposal">
      <div className="proposal-head">
        <strong>📋 {plan.title ?? 'The plan'}</strong>
        <span className="muted small">
          {plan.tasks.length} task{plan.tasks.length === 1 ? '' : 's'} · {steps} step{steps === 1 ? '' : 's'}
        </span>
        <button className="btn small" type="button" onClick={() => setReading((v) => !v)}>
          {reading ? 'Fold it back up' : 'Read the whole plan'}
        </button>
      </div>
      {/* The shape of the work, without opening anything. The full document is
          the button above; this is what it comes to. */}
      {!reading && plan.tasks.length > 0 && (
        <ol className="proposal-tasks">
          {plan.tasks.map((task, i) => (
            <li key={`${task.kind}-${task.number}-${i}`}>
              <span className="task-count">{task.number}</span>
              <span className="task-text">{task.description}</span>
              <span className="task-steps">
                {task.total} step{task.total === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ol>
      )}
      {plan.problems.length > 0 && (
        <p className="warn small">
          {plan.problems.length} problem{plan.problems.length > 1 ? 's' : ''} in the plan — {plan.problems.join('. ')}.
        </p>
      )}
      {reading && (
        <div className="brief-body">
          <Markdown text={plan.markdown} />
        </div>
      )}
    </div>
  );
}

// -- what it spent ------------------------------------------------------------

/**
 * What the run has cost, as small as it can be and still be readable.
 *
 * A token count is not a thing anyone can feel, and across two models it does
 * not even add up to one number — so the flow carries the price alone, and the
 * tokens behind it are one click away rather than nowhere.
 */
export function CostChip({ usage }: { usage: UsageReport | null }) {
  const [open, setOpen] = useState(false);
  if (!usage?.available || !Number.isFinite(usage.totals.cost)) return null;

  return (
    <>
      <button
        className="cost-chip"
        type="button"
        onClick={() => setOpen(true)}
        title="Estimated at list prices — click for the breakdown"
      >
        est. {money(usage.totals.cost)}
        {usage.live ? '…' : ''}
      </button>
      {open && <CostBreakdown usage={usage} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The tokens behind the price: per model, then per stage of the loop. */
function CostBreakdown({ usage, onClose }: { usage: UsageReport; onClose: () => void }) {
  const spent = usage.stages.filter((stage) => stage.total > 0);
  const busiest = spent.reduce((max, stage) => Math.max(max, stage.total), 0);

  return (
    <Overlay onDismiss={onClose}>
      <div className="dialog cost-dialog" role="dialog" aria-modal="true" aria-label="Estimated cost">
        <div className="dialog-head">
          <div className="brief-title">
            <h3>{money(usage.totals.cost)} estimated</h3>
            <p className="muted brief-source">{fmtTokens(usage.totals.total)} tokens in total</p>
          </div>
          <button className="btn subtle" onClick={onClose}>
            Close
          </button>
        </div>

        {usage.models.length > 0 && (
          <div className="cost-table">
            <div className="cost-caption">By model</div>
            {usage.models.map((model) => (
              <div className="cost-row" key={model.key}>
                <span className="cost-name">{model.key}</span>
                <span className="cost-tokens">{fmtTokens(model.total)}</span>
                <span className="cost-money">{Number.isFinite(model.cost) ? money(model.cost) : 'unpriced'}</span>
              </div>
            ))}
          </div>
        )}

        {spent.length > 0 && (
          <div className="cost-table">
            <div className="cost-caption">By stage</div>
            {spent.map((stage) => (
              <div className="tok-row" key={stage.key}>
                <span className="tok-name">{stage.label}</span>
                <span className="tokbar-track">
                  <span
                    className={`tokbar tok-${stage.kind}`}
                    style={{ width: `${busiest > 0 ? Math.max(2, (stage.total / busiest) * 100) : 0}%` }}
                  />
                </span>
                <span className="tok-total">{fmtTokens(stage.total)}</span>
                {Number.isFinite(stage.cost) && <span className="tok-cost">{money(stage.cost)}</span>}
              </div>
            ))}
          </div>
        )}

        {/* What the price is and is not. It is the number on the chip, so this
            has to be within reach of it rather than buried in a tooltip. */}
        <p className="muted small">
          Estimated from the tokens at list API prices ({usage.pricing.asOf}). A subscription is not billed this way.
        </p>
        {usage.caveats.map((caveat) => (
          <p className="muted small" key={caveat}>
            {caveat}
          </p>
        ))}
      </div>
    </Overlay>
  );
}
