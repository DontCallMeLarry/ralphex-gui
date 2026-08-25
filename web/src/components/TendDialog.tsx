import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  money,
  type BenchView,
  type Changes,
  type MergeRequestPlan,
  type PlanTask,
  type SpecimenView,
} from '../api.ts';
import { SproutAvatar } from '../avatar.tsx';
import { Markdown } from '../markdown.tsx';
import { Overlay } from './Overlay.tsx';
import { CostChip, Transcript, useSessionStream, type ProgressData } from './Transcript.tsx';

/**
 * The tending bench: where a specimen gets worked on.
 *
 * A card opens onto its plan — the one written at the interview — and one
 * button. It does a step, runs the plan's own validation commands, commits and
 * repeats, inside this worktree and no other. The checkboxes tick as each step
 * lands, because that file is the progress record as well as the brief.
 *
 * One button and nothing beside it. There is no dropdown of which passes to
 * run and no box for how many: growing is the whole loop, and how long it may
 * go round is read off the plan by the server. Being asked to hold an opinion
 * about a loop is the opposite of watching one work.
 *
 * No command line appears here, and no output either. What it is doing is one
 * sentence with a counter on the end; everything it printed getting there is
 * behind the technical details toggle, where a run that goes wrong can be read
 * and a run that goes right never has to be.
 */
export function TendDialog({
  specimen,
  onClose,
  onChanged,
}: {
  specimen: SpecimenView;
  onClose: () => void;
  onChanged: (updated: SpecimenView) => void;
}) {
  const [bench, setBench] = useState<BenchView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [changes, setChanges] = useState<Changes | null>(null);
  const [reading, setReading] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [settled, setSettled] = useState(false);
  const [openFallback, setOpenFallback] = useState<string | null>(null);
  /** The notes box is open: finished work, and something to say about it. */
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [merging, setMerging] = useState(false);

  const state = useSessionStream(sessionId, 'bench');

  useEffect(() => {
    let live = true;
    api.bench(specimen.id).then(
      (view) => {
        if (!live) return;
        setBench(view);
        setSessionId(view.sessionId);
        setChanges(view.changes);
      },
      (err) => live && setProblem((err as Error).message),
    );
    return () => {
      live = false;
    };
  }, [specimen.id]);

  // A run that has stopped has left something on the branch, and what it left
  // is the whole point of having run it.
  useEffect(() => {
    if (!sessionId || !state.ended || settled) return;
    setSettled(true);
    void api.changes(specimen.id).then(setChanges).catch(() => {});
    void api
      .benchSettle(sessionId)
      .then(({ specimen: updated }) => onChanged(updated))
      .catch(() => {});
  }, [sessionId, state.ended, settled, specimen.id, onChanged]);

  const answer = useCallback(
    async (requestId: string, answers: Record<string, string | string[]>) => {
      if (!sessionId) return;
      await api.benchAnswer(sessionId, requestId, answers).catch((err) => setProblem((err as Error).message));
    },
    [sessionId],
  );

  async function grow() {
    setBusy(true);
    setProblem(null);
    try {
      const { sessionId: id } = await api.grow(specimen.id);
      setSettled(false);
      setChanges(null);
      setSessionId(id);
      // The card carries the fact that something is happening in there, so it
      // hears about it now — and starts glowing now — rather than at the next
      // refresh.
      onChanged({ ...specimen, growing: true, pulse: 'working' });
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!sessionId) return;
    await api.benchStop(sessionId).catch((err) => setProblem((err as Error).message));
  }

  // Reviewing a change means reading a diff, and the only place that happens is
  // an editor — so this is the same button whether it is leading the row or
  // standing beside the one that is.
  async function openInEditor() {
    const result = await api.open(specimen.id).catch((err) => ({ ok: false, command: (err as Error).message }));
    if (!result.ok && result.command) setOpenFallback(result.command);
  }

  /**
   * Something is wrong with the finished work, and here is what.
   *
   * The loop starts again, but not from the beginning: the server turns the
   * note into a short plan of its own — what is already built, then the
   * changes, one step per line — and the run works that. So the bench is
   * looking at a different plan afterwards, which is why it re-opens rather
   * than patching what it had: everything on screen belongs to the old one.
   */
  async function askForChanges() {
    const text = note.trim();
    if (!text) return;
    setBusy(true);
    setProblem(null);
    try {
      const { sessionId: id, specimen: updated } = await api.revise(specimen.id, text);
      setAsking(false);
      setNote('');
      setSettled(false);
      setChanges(null);
      setSessionId(id);
      onChanged({ ...updated, growing: true, pulse: 'working' });
      const view = await api.bench(specimen.id).catch(() => null);
      if (view) {
        setBench(view);
        setSessionId(view.sessionId ?? id);
      }
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendDraft() {
    const text = draft.trim();
    if (!text || !sessionId) return;
    setDraft('');
    await api.benchMessage(sessionId, text).catch((err) => setProblem((err as Error).message));
  }

  const plan = bench?.plan ?? null;
  const analysis = plan?.analysis ?? null;
  // While a run is going, its own polling of the file is fresher than the copy
  // the dialog opened with.
  const progress: ProgressData['progress'] | null = state.progress?.progress ?? analysis?.progress ?? null;
  const tasks: PlanTask[] = state.progress?.tasks ?? analysis?.tasks ?? [];
  const blocked = useMemo(() => reasonNotToGrow(bench, specimen), [bench, specimen]);
  const errors = analysis?.diagnostics.filter((d) => d.severity === 'error') ?? [];

  return (
    // Closing the bench never stops the run: it keeps going in the worktree, the
    // card says so, and opening the bench again picks the transcript back up.
    <Overlay onDismiss={onClose}>
      <div className="dialog bench" role="dialog" aria-modal="true" aria-label={`${specimen.name} — the bench`}>
        <div className="dialog-head">
          <SproutAvatar seed={specimen.avatarSeed} stage={specimen.stage} size={44} animated={state.live} />
          <div className="brief-title">
            <h3>{analysis?.title || specimen.name}</h3>
            <p className="muted brief-source" title={plan?.file ?? undefined}>
              {specimen.branch}
            </p>
          </div>
          <CostChip usage={state.usage} />
          <button className="btn subtle" onClick={onClose}>
            Close
          </button>
        </div>

        {!bench && !problem && <p className="muted">Opening the bench…</p>}

        {/* The plan's own steps, ticking as each one lands — the design
            document and the progress at the same time, because that is what
            the file is. No count and no bar above them: how far along it is is
            the card's job, said by the card growing, and a number of steps is
            not something anybody came here to read.

            The steps are the short form of the plan and the document is the
            long one, so the link that swaps them sits with them rather than
            down among the buttons, and swaps in place. */}
        {(progress || plan?.markdown) && (
          <div className="plan-progress">
            {(progress?.complete || plan?.markdown) && (
              <div className="plan-progress-head">
                {progress?.complete && <strong className="plan-done">Work done</strong>}
                {/* On the document itself, not on the file being there: a link
                    that opens nothing is worse than no link. */}
                {plan?.markdown && (
                  <button className="linkish plan-read" onClick={() => setReading((v) => !v)}>
                    {reading ? 'Back to the steps' : 'Read the plan'}
                  </button>
                )}
              </div>
            )}
            {reading && plan?.markdown ? (
              <div className="brief-body">
                <Markdown text={plan.markdown} />
              </div>
            ) : (
              <PlanTasks tasks={tasks} />
            )}
          </div>
        )}

        {bench && !plan?.file && (
          <p className="muted">
            Nothing to grow here. A plan is written at the interview, and this worktree came from somewhere else, so
            there is no plan to work through.
          </p>
        )}

        {errors.length > 0 && (
          <p className="warn">
            {errors.length} problem{errors.length > 1 ? 's' : ''} in the plan — it cannot be worked as it stands.{' '}
            {errors.map((d) => `line ${d.line}: ${d.message}`).join('. ')}.
          </p>
        )}

        {/* The transcript only exists once something is running. Before that
            the bench is the plan and one button, which is the whole idea. */}
        {sessionId && <Transcript state={state} working="Settling its roots in…" onAnswer={answer} />}

        {problem && <p className="warn">{problem}</p>}
        {state.streamDown && !state.ended && <p className="warn">⚠ Lost the live feed. Reconnecting…</p>}

        {sessionId && state.live && (
          <footer className="sprout-input">
            <textarea
              rows={2}
              placeholder={state.pending ? 'Answer above — or type your reply here.' : 'Type a reply…'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void sendDraft();
                }
              }}
            />
            <div className="sprout-input-actions">
              <button className="btn" onClick={sendDraft} disabled={!draft.trim()}>
                Send
              </button>
              <button className="btn danger-outline" onClick={stop}>
                Stop
              </button>
            </div>
          </footer>
        )}

        {changes && <Landed changes={changes} />}

        {bench && !state.live && (
          <div className="bench-run">
            {/* Whether there is anything left to do is said by what the bench
                offers, not by a paragraph about it. While there are steps left,
                the loud button is the one that does them.

                Once they are all ticked the row is what happens next, in the
                order it happens: read it, say what is wrong with it, send it.
                There is no bare "grow it again" among them — the same plan
                round the loop a second time is not a thing anybody wants; what
                they want is the bit that is wrong fixed, and that is the
                middle button. */}
            {asking ? (
              <AskForChanges
                note={note}
                busy={busy}
                onNote={setNote}
                onSend={askForChanges}
                onCancel={() => setAsking(false)}
              />
            ) : (
              <div className="bench-actions">
                {progress?.complete ? (
                  <>
                    {specimen.present && (
                      <button className="btn primary" onClick={openInEditor}>
                        Review in VS Code
                      </button>
                    )}
                    <button
                      className="btn"
                      onClick={() => setAsking(true)}
                      disabled={busy || blocked !== null}
                      title={blocked ?? undefined}
                    >
                      Ask for changes
                    </button>
                    <button className="btn ready" onClick={() => setMerging(true)}>
                      Ready — open a merge request
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="btn primary"
                      onClick={grow}
                      disabled={busy || blocked !== null}
                      title={blocked ?? undefined}
                    >
                      {sessionId ? '🌿 Grow it again' : '🌿 Grow it'}
                    </button>
                    {specimen.present && (
                      <button className="btn" onClick={openInEditor}>
                        Open in VS Code
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
            {blocked && <p className="muted">{blocked}</p>}
            {openFallback && (
              <div className="open-fallback">
                <span>The `code` CLI isn't available. Run this instead:</span>
                <code>{openFallback}</code>
                <button className="btn subtle" onClick={() => setOpenFallback(null)}>
                  Dismiss
                </button>
              </div>
            )}
            {specimen.lastRun && !sessionId && <LastRunLine run={specimen.lastRun} />}
          </div>
        )}

        {merging && (
          <SendItOff specimen={specimen} onClose={() => setMerging(false)} onChanged={onChanged} />
        )}
      </div>
    </Overlay>
  );
}

/**
 * What is wrong with the finished work, in the developer's own words.
 *
 * A box and two buttons, in place of the row it came from: one thing on screen
 * at a time, and the thing on screen is the sentence being written. It is not
 * the interview — nothing is asked back, nothing is designed. Each line becomes
 * a step, which is the only rule worth printing, because it is the one that
 * decides whether a run does three small commits or one big one.
 */
function AskForChanges({
  note,
  busy,
  onNote,
  onSend,
  onCancel,
}: {
  note: string;
  busy: boolean;
  onNote: (text: string) => void;
  onSend: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="ask-changes">
      <textarea
        rows={4}
        autoFocus
        placeholder="What needs changing? One thing per line."
        value={note}
        onChange={(e) => onNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSend();
          }
        }}
      />
      <p className="muted small">
        Each line becomes a step. What is already built stays — the loop is told to change the least that will do.
      </p>
      <div className="bench-actions">
        <button className="btn primary" onClick={onSend} disabled={busy || !note.trim()}>
          🌿 Work these in
        </button>
        <button className="btn subtle" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Send it off: push the branch and open the merge request.
 *
 * Everything else in the Terrarium happens on this machine and can be undone
 * with a git command. This cannot — it is the one action other people see — so
 * it is the one action that asks first, and what it asks with is the whole of
 * what it is about to do: which branch, into which, called what, and how much
 * of the worktree is not in it.
 */
function SendItOff({
  specimen,
  onClose,
  onChanged,
}: {
  specimen: SpecimenView;
  onClose: () => void;
  onChanged: (updated: SpecimenView) => void;
}) {
  const [plan, setPlan] = useState<MergeRequestPlan | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ url: string | null } | null>(null);

  useEffect(() => {
    let live = true;
    api.mergeRequestCheck(specimen.id).then(
      (view) => live && setPlan(view),
      (err) => live && setProblem((err as Error).message),
    );
    return () => {
      live = false;
    };
  }, [specimen.id]);

  async function send() {
    setBusy(true);
    setProblem(null);
    try {
      const result = await api.mergeRequest(specimen.id);
      setSent({ url: result.url });
      onChanged(result.specimen);
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Overlay onDismiss={busy ? () => {} : onClose}>
      <div className="dialog send-off" role="dialog" aria-modal="true" aria-label="Open a merge request">
        <div className="dialog-head">
          <div className="brief-title">
            <h3>{sent ? 'It is up' : 'Send it off'}</h3>
            {plan && !sent && (
              <p className="muted brief-source">
                {plan.branch} → {plan.target ?? '…'}
              </p>
            )}
          </div>
        </div>

        {!plan && !problem && <p className="muted">Working out what that would do…</p>}

        {plan && !sent && !plan.blocked && (
          <>
            <p className="send-what">
              <strong>{plan.title}</strong>
            </p>
            <p className="muted">
              {plan.commits} commit{plan.commits === 1 ? '' : 's'} over {plan.files} file
              {plan.files === 1 ? '' : 's'}, pushed to origin and opened as a merge request into {plan.target}.
            </p>
            {plan.uncommitted > 0 && (
              <p className="warn">
                {plan.uncommitted} file{plan.uncommitted === 1 ? '' : 's'} in the worktree{' '}
                {plan.uncommitted === 1 ? 'is' : 'are'} not committed, so {plan.uncommitted === 1 ? 'it' : 'they'} will
                not be in it.
              </p>
            )}
            <p className="muted small">
              Nobody has reviewed this. The plan's boxes are the loop's own ticks, and this is the first time any of it
              leaves the machine.
            </p>
          </>
        )}

        {plan?.blocked && !sent && <p className="warn">{plan.blocked}</p>}
        {problem && <p className="warn">{problem}</p>}

        {sent && (
          <p className="send-done">
            The branch is pushed and the merge request is open.{' '}
            {sent.url ? (
              <a href={sent.url} target="_blank" rel="noreferrer">
                {sent.url}
              </a>
            ) : (
              'GitLab did not say where.'
            )}
          </p>
        )}

        <div className="dialog-actions">
          {plan && !plan.blocked && !sent && (
            <button className="btn ready" onClick={send} disabled={busy}>
              {busy ? 'Pushing…' : 'Push it and open the merge request'}
            </button>
          )}
          <button className="btn subtle" onClick={onClose} disabled={busy}>
            {sent ? 'Done' : 'Cancel'}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/**
 * The plan's tasks, in a quiet scroll area of their own.
 *
 * It opens on the first thing not finished, rather than at the top or wherever
 * it was left. A plan is read to answer one question — what is it on? — and
 * scrolling to find that out is the reader doing the screen's job.
 */
function PlanTasks({ tasks }: { tasks: PlanTask[] }) {
  const list = useRef<HTMLOListElement>(null);
  const at = tasks.findIndex((task) => !(task.total > 0 && task.done === task.total));

  useEffect(() => {
    const el = list.current;
    if (!el || at < 0) return;
    const item = el.children[at] as HTMLElement | undefined;
    if (!item) return;
    // Its own box only. `scrollIntoView` would take the dialog with it.
    el.scrollTop = Math.max(0, item.offsetTop - el.offsetTop - 8);
  }, [at]);

  return (
    <ol className="plan-tasks" ref={list}>
      {tasks.map((task, i) => {
        // A finished step is a tick, not a sum. `6/6` is the same fact said
        // twice and then struck through, and a plan of them is a column of
        // arithmetic nobody reads. The count is only worth printing while it
        // is still moving.
        const done = task.total > 0 && task.done === task.total;
        return (
          <li key={`${task.kind}-${task.number}-${i}`} className={done ? 'done' : ''}>
            <span className={`task-count${done ? ' ticked' : ''}`}>
              {done ? '✓' : task.total > 0 ? `${task.done}/${task.total}` : ''}
            </span>
            <span className="task-text">{task.description}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Why the button is disabled, in a sentence, or null when it is not. */
function reasonNotToGrow(bench: BenchView | null, specimen: SpecimenView): string | null {
  if (!bench) return 'Still opening.';
  if (!specimen.present) return 'This worktree is gone, so there is nothing to work in.';
  if (!bench.sproutEnabled) {
    return 'Growing is switched off in terrarium.config.json, so this button does nothing.';
  }
  if (!bench.doctor.ready) {
    return `Not installed: ${bench.doctor.missingRequired.join(' and ')}. Everything else in the Terrarium still works.`;
  }
  if (!bench.plan.file) return 'There is no plan here to work through.';
  if (bench.plan.analysis && !bench.plan.analysis.valid) {
    return 'The plan has problems it would trip over. Fix them in the file first.';
  }
  return null;
}

/** What the last run came to, remembered across restarts. */
function LastRunLine({ run }: { run: NonNullable<SpecimenView['lastRun']> }) {
  const when = new Date(run.at).toLocaleString();
  // How it went, when, and what it cost. Not how many steps it got through —
  // the plan above already shows which ones, and a count of them is arithmetic
  // rather than news.
  const bits = [run.status, when];
  if (run.cost !== null && run.cost !== undefined) bits.push(`est. ${money(run.cost)}`);
  return <p className="muted small">Last run: {bits.join(' · ')}</p>;
}

/**
 * What ended up on the branch. Nothing is pushed: you read it and decide.
 *
 * The size of it and where it is waiting, and that is all. A list of the files
 * a run touched is not a review and cannot be turned into one by reading it —
 * reviewing a change means reading the diff, which happens in an editor. So
 * the count is the whole of what this says, and the sentence under it is about
 * getting to the only place the change can actually be read.
 */
function Landed({ changes }: { changes: Changes }) {
  if (!changes.available) {
    return <p className="muted">{changes.reason ?? 'Nothing on this branch yet.'}</p>;
  }
  return (
    <div className="landed">
      <div className="landed-head">
        <strong>
          {changes.fileCount} file{changes.fileCount === 1 ? '' : 's'} changed
        </strong>
        <span className="muted">
          {changes.commitCount} commit{changes.commitCount === 1 ? '' : 's'} · +{changes.totals?.added} −
          {changes.totals?.removed}
        </span>
      </div>
      <p className="landed-note">{whereItIsWaiting(changes)}</p>
    </div>
  );
}

/**
 * Where the change is waiting, and it is always waiting somewhere. ralphex
 * commits as it goes; whatever it leaves loose is staged the moment the run
 * stops, and again every time this is read — so the worktree opens on a diff
 * rather than on a folder with something changed in it somewhere.
 *
 * Counted, never assumed: git can refuse, and "staged and ready" about an index
 * nothing reached would be a lie about the one thing this line is for.
 */
function whereItIsWaiting(changes: Changes): string {
  const loose = changes.uncommitted ?? 0;
  const staged = changes.staged ?? 0;
  const read = 'Open it in VS Code to read the diff — nothing is pushed until you say so.';
  if (loose === 0) return `All of it is committed to the branch. ${read}`;
  if (staged >= loose) {
    return `${loose} file${loose === 1 ? '' : 's'} not committed, staged and ready. ${read}`;
  }
  return `${loose} file${loose === 1 ? '' : 's'} not committed, ${staged} of them staged — git would not take the rest. ${read}`;
}
