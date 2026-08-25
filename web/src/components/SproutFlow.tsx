import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SpecimenView } from '../api.ts';
import { SproutAvatar } from '../avatar.tsx';
import { CostChip, PlanCard, Transcript, useSessionStream } from './Transcript.tsx';

/**
 * Sprout: the interview, and the seedling it earns.
 *
 * Four screens, one after the other, and only ever one of them on the glass:
 *
 *   say what you want built  →  answer what it asks  →  the plan  →  the specimen
 *
 * Each is finished before the next begins. The questions are questions and
 * nothing else; the moment there is a plan the questions are behind you and
 * the plan is the whole screen. Nothing is pinned above anything else, because
 * a thing that matters at one step is clutter at the other three.
 *
 * The plan screen has two ways on and no third. Say what is wrong with the
 * plan and it goes back for another pass; sprout it and it is taken — which is
 * the whole of approving it, so there is no button that only agrees. What
 * ralphex actually asks at that moment (Accept, Revise, Interactive review,
 * Reject) never reaches the glass: half of it cannot happen through a browser,
 * and the other half is these two buttons.
 */
export function SproutFlow({
  repos,
  initialRepo,
  onClose,
  onFinished,
}: {
  repos: string[];
  /** Preselected when the flow was opened from a specific repo's section. */
  initialRepo?: string | null;
  onClose: () => void;
  onFinished: () => void;
}) {
  const [started, setStarted] = useState(false);
  const [repo, setRepo] = useState(initialRepo && repos.includes(initialRepo) ? initialRepo : (repos[0] ?? ''));
  const [description, setDescription] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [specimens, setSpecimens] = useState<SpecimenView[] | null>(null);
  const [draft, setDraft] = useState('');
  /** Taking the plan is under way: from the click until there is a specimen. */
  const [busy, setBusy] = useState(false);

  const state = useSessionStream(sessionId, 'sprout');

  /**
   * Which of the four screens is up. Derived, not remembered, so it cannot get
   * out of step with the session: the plan screen is up while there is a plan
   * and ralphex is waiting to be told what to do with it, once the file it
   * wrote is on disk, all the way through taking it — and after the interview
   * has gone, because a plan on the glass can still be sprouted whatever
   * happened to the process that drafted it. Sending the plan back stops all of
   * that being true, which is what walks the flow home to the questions until
   * the next draft lands.
   */
  const potting = busy && started && specimens === null;
  const onThePlan = state.plan !== null && (state.reviewing || state.ready || potting || state.ended);
  const phase = specimens ? 'done' : !started ? 'setup' : onThePlan ? 'plan' : 'asking';

  async function start() {
    setBusy(true);
    setProblem(null);
    try {
      // The server fetches origin before the interview starts, so the worktree
      // comes off current code. If that did not work, say so rather than
      // letting the branch quietly come off something stale.
      const { sessionId: id, sync } = await api.sproutStart(repo, description);
      setSyncNote(sync?.problem ? (sync.detail ?? sync.problem) : null);
      setSessionId(id);
      setStarted(true);
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const answer = useCallback(
    async (requestId: string, answers: Record<string, string | string[]>) => {
      if (!sessionId) return;
      await api.sproutAnswer(sessionId, requestId, answers).catch((err) => setProblem((err as Error).message));
    },
    [sessionId],
  );

  /** Send what was typed: an answer while it is asking, feedback on the plan. */
  async function send() {
    const text = draft.trim();
    if (!text || !sessionId) return;
    setDraft('');
    await api.sproutMessage(sessionId, text).catch((err) => setProblem((err as Error).message));
  }

  /**
   * Take the plan.
   *
   * A plan that is still a draft has no file yet, and taking it is what sets
   * ralphex writing one. So this can come back with nothing to pot, and the
   * effect below finishes the job when the file lands.
   */
  const sprout = useCallback(async () => {
    if (!sessionId) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await api.sproutFinish(sessionId);
      if (result.specimens.length > 0 || !result.writing) setSpecimens(result.specimens);
    } catch (err) {
      setProblem((err as Error).message);
      setBusy(false);
    }
  }, [sessionId]);

  // The plan file landing is what finishes a sprout that started on a draft —
  // and the interview dying before it lands is what gives the buttons back.
  const again = useRef(false);
  useEffect(() => {
    if (!potting) return;
    if (state.ended && !state.ready) {
      setBusy(false);
      return;
    }
    if (!state.ready || again.current) return;
    again.current = true;
    void sprout();
  }, [potting, state.ready, state.ended, sprout]);

  async function abandon() {
    if (sessionId) {
      const warning = state.ready
        ? 'Abandon this sprout? Its worktree, branch and plan will be composted (deleted).'
        : 'Abandon this interview? Nothing has been grown yet.';
      if (!window.confirm(warning)) return;
      await api.sproutAbort(sessionId).catch(() => {});
    }
    onClose();
  }

  return (
    <div className="overlay sprout-overlay">
      <div className="sprout-panel">
        <header className="sprout-head">
          <h2>{HEADINGS[phase]}</h2>
          <div className="sprout-head-actions">
            <CostChip usage={state.usage} />
            <button className="btn subtle" onClick={phase === 'done' ? onFinished : abandon}>
              {phase === 'done' || (state.ended && !state.plan) ? 'Close' : 'Abandon'}
            </button>
          </div>
        </header>

        {phase === 'setup' && (
          <div className="sprout-setup">
            <label className="field">
              <span>Repository</span>
              <select value={repo} onChange={(e) => setRepo(e.target.value)}>
                {repos.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>What do you want built?</span>
              <textarea
                rows={6}
                placeholder="A paragraph is plenty. It reads the repo, asks you what it still needs to know, and writes the plan — including its title, which becomes the branch."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                autoFocus
              />
            </label>
            {problem && <p className="warn">{problem}</p>}
            <div className="dialog-actions">
              <button className="btn primary" onClick={start} disabled={busy || !repo || !description.trim()}>
                {busy ? 'Germinating…' : '🌱 Germinate'}
              </button>
            </div>
          </div>
        )}

        {/* The questions, and nothing else. There is no plan yet, so there is
            nothing to pot and no button offering to. */}
        {phase === 'asking' && (
          <>
            <Transcript
              state={state}
              working={state.plan ? 'Working your notes back in…' : 'Reading the ground and drawing the plan up…'}
              onAnswer={answer}
            />

            {state.status === 'failed' && (
              <div className="sprout-banner alarmed">
                ✖ It stopped without a plan. Nothing was grown; there is nothing to clean up.
              </div>
            )}
            {state.status === 'cancelled' && <div className="sprout-banner quiet">⏸ You stopped this interview.</div>}
            {state.streamDown && !state.ended && <p className="warn">⚠ Lost the live feed. Reconnecting…</p>}
            {syncNote && <p className="warn">⚠ {syncNote}</p>}
            {problem && <p className="warn">{problem}</p>}

            <footer className="sprout-input">
              <textarea
                rows={2}
                placeholder={
                  state.pending
                    ? 'Answer above — or type your reply here instead.'
                    : 'Type a reply… (Enter to send, Shift+Enter for a newline)'
                }
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                disabled={state.ended}
              />
              <div className="sprout-input-actions">
                <button className="btn" onClick={send} disabled={!draft.trim() || state.ended}>
                  Send
                </button>
              </div>
            </footer>
          </>
        )}

        {/* The plan, and the two things anyone wants to do with one. */}
        {phase === 'plan' && state.plan && (
          <>
            <PlanCard plan={state.plan} />

            {potting && (
              <div className="sprout-banner">{state.ready ? POTTING : SOWING}</div>
            )}
            {state.status === 'failed' && !state.ready && !potting && (
              <div className="sprout-banner alarmed">
                ✖ It stopped before the seed went in. Sprouting it plants the plan above anyway.
              </div>
            )}
            {state.streamDown && !state.ended && <p className="warn">⚠ Lost the live feed. Reconnecting…</p>}
            {syncNote && <p className="warn">⚠ {syncNote}</p>}
            {problem && <p className="warn">{problem}</p>}

            <footer className="sprout-input">
              <textarea
                rows={2}
                placeholder="Something wrong with it? Say what to change and it goes back for another pass."
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                disabled={potting || state.ended}
              />
              <div className="sprout-input-actions">
                <button className="btn" onClick={send} disabled={!draft.trim() || potting || state.ended}>
                  Send it back
                </button>
                <button
                  className="btn primary"
                  onClick={sprout}
                  disabled={potting}
                  title="Take this plan: a branch named after it, a worktree beside its siblings, and the plan committed onto it"
                >
                  {potting ? 'Sprouting…' : '🪴 Sprout it'}
                </button>
              </div>
            </footer>
          </>
        )}

        {phase === 'done' && specimens && (
          <div className="sprout-done">
            {specimens.length > 0 ? (
              <>
                <h3>Meet your new specimen</h3>
                {specimens.map((s) => (
                  <div key={s.id} className="new-specimen">
                    <SproutAvatar seed={s.avatarSeed} stage={s.stage} size={96} />
                    <div>
                      <div className="specimen-name">{s.name}</div>
                      <div className="specimen-meta" title={s.worktreePath}>
                        {s.branch}
                      </div>
                      <p className="muted">Its plan is committed and waiting. Click the card to set it working.</p>
                      <button className="btn" onClick={() => void api.openPath(s.worktreePath)}>
                        Open in VS Code
                      </button>
                    </div>
                  </div>
                ))}
              </>
            ) : (
              <p className="muted">The interview ended without a worktree. Nothing was kept.</p>
            )}
            <div className="dialog-actions">
              <button className="btn primary" onClick={onFinished}>
                Back to the Terrarium
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Taking the plan, in the two things that actually happen. The draft is
 * accepted first, which is what sets ralphex writing the file — the seed going
 * into the ground — and the seedling is potted once it lands.
 */
const SOWING = '🌰 Pressing the seed into the soil…';
const POTTING = '🪴 Potting it up — a pot, some soil, and a label…';

/** The heading says which of the four screens you are on. */
const HEADINGS: Record<string, string> = {
  setup: '🌱 Sprout a new worktree',
  asking: '🌱 What it needs to know',
  plan: '📋 The plan',
  done: '🪴 Potted',
};
