import {
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  api,
  money,
  type Checklist,
  type PlanDoc,
  type DeploySignal,
  type MergeRequest,
  type Pipeline,
  type SpecimenView,
  type Stage,
} from '../api.ts';
import { SproutAvatar } from '../avatar.tsx';
import { Markdown } from '../markdown.tsx';
import { Overlay } from './Overlay.tsx';
import { TendDialog } from './TendDialog.tsx';

/**
 * Everything on a card that already means something when you press it. A click
 * that lands on one of these is that thing's click and never the card's.
 */
const PRESSABLE = 'button, a, input, label, textarea, select, code, .overlay';

/**
 * One label per tick of the checklist — every box moves the plant on. The mark
 * is kept apart from the word so it can be sized down against it: an emoji
 * carries more ink than letters at the same font size.
 */
const STAGE_LABEL: Record<Stage, { mark: string; text: string }> = {
  seedling: { mark: '🌱', text: 'Seedling' },
  growing: { mark: '🌿', text: 'Growing' },
  budding: { mark: '🌸', text: 'Budding' },
  ready: { mark: '✂️', text: 'Ready to prune' },
};

const CHECKS: Array<{ key: keyof Checklist; label: string; hint: string }> = [
  { key: 'sandbox', label: 'Sandbox', hint: 'Verified in the sandbox environment' },
  { key: 'qa', label: 'QA', hint: 'Verified in QA' },
  { key: 'production', label: 'Production', hint: 'Verified in production — the one that is live' },
];

/**
 * The plant's one ask: monitoring noticed something the checklist hasn't
 * caught up with. It never ticks the boxes — it says what it saw and waits for
 * the human tick, which is also the only thing that quiets it.
 */
interface Nudge {
  /** How far the change has actually got — the box the ask is about. */
  key: keyof Checklist;
  /** Every box up to and including that one that is still empty. */
  behind: Array<keyof Checklist>;
  text: string;
  /** The exact evidence, for the hover — what was seen, where, and when. */
  evidence: string;
}

/** Sandbox, then QA, then production: the order a change travels in. */
const ORDER: Array<keyof Checklist> = ['sandbox', 'qa', 'production'];

/**
 * The ask is always about the furthest place the change has reached, not the
 * first empty box. Something already live in production should say so, and one
 * tick should catch the whole checklist up to it — walking the plant through
 * sandbox and QA it has long since left is busywork.
 *
 * A merged MR is itself the sandbox evidence (merging means development in
 * sandbox is presumably done); QA and production need a deploy signal.
 */
function nudgeFor(specimen: SpecimenView): Nudge | null {
  const mr = specimen.mr;
  if (!mr || mr.state !== 'merged' || specimen.archivedAt) return null;

  let key: keyof Checklist = 'sandbox';
  let evidence = `MR !${mr.iid} has merged.`;
  for (const env of ['qa', 'production'] as const) {
    // `?? []` — a server older than this field answers with MRs that don't
    // carry it, and a missing signal must degrade to "no ask", not a crash.
    const signal = (mr.deployed ?? []).find((s) => s.env === env);
    if (!signal) continue;
    key = env;
    evidence = evidenceLine(signal);
  }

  const behind = ORDER.slice(0, ORDER.indexOf(key) + 1).filter((k) => !specimen.checklist[k]);
  if (!behind.length) return null;
  return { key, behind, evidence, text: NUDGE_TEXT[key] };
}

/** Short enough to sit on the bubble's one line, with the button beside it. */
const NUDGE_TEXT: Record<keyof Checklist, string> = {
  sandbox: 'This looks merged.',
  qa: 'This looks deployed to QA.',
  production: 'This looks live in production.',
};

function evidenceLine(signal: DeploySignal): string {
  const when = new Date(signal.at).toLocaleString();
  return signal.source === 'environment'
    ? `GitLab's newest successful deployment to “${signal.name}” (${when}) contains this merge.`
    : `The deploy job “${signal.name}” succeeded on this change's pipeline (${when}).`;
}

export function SpecimenCard({
  specimen,
  onChanged,
  onPrune,
}: {
  specimen: SpecimenView;
  onChanged: (updated: SpecimenView) => void;
  onPrune: (specimen: SpecimenView) => void;
}) {
  // Always closed on arrival — the button says “Notes ✎” when there are some,
  // which is all the card owes a note that future-you wrote to future-you.
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState(specimen.notes);
  const [openFallback, setOpenFallback] = useState<string | null>(null);
  const [benchOpen, setBenchOpen] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // `minimized` is the stored tucked state: cards with it set don't render
  // here at all — they sit on their repo's back shelf as TuckedSpecimen tiles.

  async function patch(body: Parameters<typeof api.updateSpecimen>[1]) {
    onChanged({ ...specimen, ...(await api.updateSpecimen(specimen.id, body)) });
  }

  async function toggleCheck(key: keyof Checklist) {
    await patch({ checklist: { ...specimen.checklist, [key]: !specimen.checklist[key] } });
  }

  /** The bubble's one button: every box the change has already passed, at once. */
  async function catchUp(keys: Array<keyof Checklist>) {
    await patch({ checklist: { ...specimen.checklist, ...Object.fromEntries(keys.map((k) => [k, true])) } });
  }

  async function saveNotes() {
    if (notes === specimen.notes) return;
    await patch({ notes });
  }

  async function openInVsCode() {
    setBusy(true);
    try {
      const result = await api.open(specimen.id);
      if (!result.ok && result.command) setOpenFallback(result.command);
    } catch (err) {
      setOpenFallback((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const elsewhere = locationHint(specimen);
  const nudge = nudgeFor(specimen);
  const steps = specimen.plan?.total ?? 0;

  /**
   * A click anywhere on the card opens the bench — anywhere that was not
   * already something to press. Buttons, checkboxes, the links out to GitLab
   * and the notes box all mean what they say, and a card-wide handler that
   * swallowed them would make the card worse, not friendlier.
   *
   * `.overlay` is in that list because the modals this card opens are its own
   * children: without it, clicking the dark to dismiss one would bubble back
   * up here and re-open it in the same breath.
   */
  function openBench(event: ReactMouseEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest(PRESSABLE)) return;
    setBenchOpen(true);
  }

  /** Enter or Space on the card itself, since nothing inside it is the way in. */
  function openOnKey(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    setBenchOpen(true);
  }

  return (
    // The whole card is the way in to the bench — anywhere on it that is not
    // already something you can press. A card is one thing about one piece of
    // work, so hunting for the one word on it that was a link was always the
    // wrong game.
    //
    // The glow behind it is the one thing on the shelf that says what is
    // happening in there without being read: green and breathing while it works,
    // steady blue while it waits on an answer, steady red when it stopped badly.
    <article
      className={`specimen-card${specimen.present ? '' : ' removed'}`}
      data-pulse={specimen.pulse ?? undefined}
      onClick={openBench}
      onKeyDown={openOnKey}
      tabIndex={0}
      aria-label={`${specimen.name} — open the bench`}
      title={`${details(specimen)}\n\nClick anywhere to open the bench: the plan, and the button that works it`}
    >
      <div className="specimen-main">
        {/* The plant itself is the way to read what this worktree is for. It
            looks like a picture and nothing else, which is the idea: the brief
            is there for the once you want it, not sitting on the card taking
            room from the work. */}
        <button
          className="avatar-button"
          onClick={() => setBriefOpen(true)}
          title={`What ${specimen.name} is for`}
          aria-label={`What ${specimen.name} is for`}
        >
          <SproutAvatar seed={specimen.avatarSeed} stage={specimen.stage} size={52} />
        </button>
        <div className="specimen-id">
          {/* Top line: where the merge request stands and what its pipeline is
              doing — the two things outside the terrarium. Both are links out,
              and both fit on one line, which is part of what keeps every card
              the same height. Then the name, then the branch underneath. */}
          <div className="specimen-links">
            {specimen.mr && (
              <a
                className={`mr-link mr-${specimen.mr.draft && specimen.mr.state === 'opened' ? 'draft' : specimen.mr.state}`}
                href={specimen.mr.url}
                target="_blank"
                rel="noreferrer"
                title={`${specimen.mr.title}\n\nOpen merge request !${specimen.mr.iid} on GitLab (new tab)`}
              >
                {mrLabel(specimen.mr)}
                <span className="external" aria-hidden="true">
                  ↗
                </span>
              </a>
            )}
            {specimen.mr?.pipeline && <PipelineChip pipeline={specimen.mr.pipeline} />}
          </div>
          {/* Both are plain text now. The whole card goes to the bench, so a
              name that was also a link was two doors into one room. */}
          <div className="specimen-name">{specimen.name}</div>
          <div className="specimen-branch">{specimen.branch}</div>
          <div className="specimen-meta">
            {!specimen.present && (
              <span
                className="removed-badge"
                title="The branch's lifecycle outlives the worktree — prune when shipped."
              >
                <span className="mark" aria-hidden="true">
                  🍂
                </span>
                worktree removed
              </span>
            )}
            {elsewhere && (
              <span className="specimen-path" title={specimen.worktreePath}>
                in {elsewhere}
              </span>
            )}
          </div>
        </div>
        {/* The corner: how ripe it is, and directly under it the three boxes
            that ripen it. Cause sits above effect — tick a box and the chip
            right above your cursor moves on. Neither needs to shout, and
            together they're the tallest thing on the card, which is what makes
            every card the same height. */}
        <div className="specimen-corner">
          <span className={`stage-chip stage-chip-${specimen.stage}`}>
            <span className="mark" aria-hidden="true">
              {STAGE_LABEL[specimen.stage].mark}
            </span>
            {STAGE_LABEL[specimen.stage].text}
          </span>
          <div className="specimen-checks" role="group" aria-label="Verified in">
            {CHECKS.map(({ key, label, hint }) => {
              const inputId = `${specimen.id}-${key}`;
              return (
                <label
                  key={key}
                  className={`check-mini check-${key}${specimen.checklist[key] ? ' checked' : ''}${
                    nudge?.behind.includes(key) ? ' nudged' : ''
                  }`}
                  htmlFor={inputId}
                  title={hint}
                >
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={specimen.checklist[key]}
                    onChange={() => void toggleCheck(key)}
                  />
                  <span>{label}</span>
                </label>
              );
            })}
          </div>
        </div>
      </div>

      {/* The speech bubble: tail up at the avatar, one short sentence, and the
          tick it is asking for beside it — ticking is also how it goes away. */}
      {nudge && (
        <div className="speech-bubble" role="status" title={nudge.evidence}>
          <span className="speech-text">{nudge.text}</span>
          <button
            className="btn subtle speech-tick"
            onClick={() => void catchUp(nudge.behind)}
            title={`Tick ${listLabels(nudge.behind)}`}
          >
            Catch up ✓
          </button>
        </div>
      )}

      <div className="specimen-body">
        <div className="specimen-footer">
          <div className="specimen-actions">
            <button className="btn" onClick={() => setNotesOpen((v) => !v)}>
              {notesOpen ? 'Hide notes' : specimen.notes ? 'Notes ✎' : 'Add note'}
            </button>
            <button
              className="btn"
              onClick={() => void patch({ minimized: true })}
              title="Tuck it onto the back shelf — still tracked, just out of the way"
            >
              Tuck away
            </button>
            {specimen.present ? (
              <button className="btn" onClick={() => void openInVsCode()} disabled={busy}>
                Open in VS Code
              </button>
            ) : (
              // Said out loud rather than left to a tooltip on a greyed button.
              <span className="action-note">Nothing to open — the worktree is gone</span>
            )}
            <button className="btn danger-outline" onClick={() => onPrune(specimen)}>
              Prune
            </button>
          </div>
        </div>

        {notesOpen && (
          <textarea
            className="notes"
            placeholder="Notes for future-you…"
            aria-label={`Notes for ${specimen.name}`}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => void saveNotes()}
            rows={2}
          />
        )}

        {openFallback && (
          <div className="open-fallback">
            <span>The `code` CLI isn't available. Run this instead:</span>
            <code>{openFallback}</code>
            <button
              className="btn subtle"
              onClick={() => {
                void navigator.clipboard.writeText(openFallback);
                setOpenFallback(null);
              }}
            >
              Copy &amp; dismiss
            </button>
          </div>
        )}
      </div>

      {/* How far the plan has got, along the foot of the card: a thick green
          line as wide as the fraction of its steps that are ticked. Half the
          steps, half the card. It is the plan file's own checkboxes, so it
          creeps along while a run is going, and it says it in the one way that
          needs no reading — no sentence, no count, no room taken from the card. */}
      {steps > 0 && (
        <span className="growth-track" title={`${specimen.plan!.done} of ${steps} steps ticked`} aria-hidden="true">
          <i style={{ width: `${specimen.plan!.percent}%` }} />
        </span>
      )}

      {briefOpen && <BriefDialog specimen={specimen} onClose={() => setBriefOpen(false)} />}

      {benchOpen && (
        <TendDialog specimen={specimen} onClose={() => setBenchOpen(false)} onChanged={onChanged} />
      )}
    </article>
  );
}

/**
 * What this worktree is for, and nothing else.
 *
 * The plan's own Overview is the answer — it is the one paragraph the
 * interview wrote to say why the work exists, and it is otherwise buried in a
 * document behind a button behind the bench. Reached by pressing the plant,
 * which is the only thing on the card that looks like decoration.
 */
function BriefDialog({ specimen, onClose }: { specimen: SpecimenView; onClose: () => void }) {
  const [plan, setPlan] = useState<PlanDoc | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.plan(specimen.id).then(
      (doc) => live && setPlan(doc),
      (err) => live && setProblem((err as Error).message),
    );
    return () => {
      live = false;
    };
  }, [specimen.id]);

  const purpose = plan?.analysis?.overview?.trim() ?? '';

  return (
    <Overlay onDismiss={onClose}>
      <div className="dialog brief" role="dialog" aria-modal="true" aria-label={`What ${specimen.name} is for`}>
        <div className="dialog-head">
          <SproutAvatar seed={specimen.avatarSeed} stage={specimen.stage} size={44} />
          <div className="brief-title">
            <h3>{plan?.analysis?.title || specimen.name}</h3>
            <p className="muted brief-source">{specimen.branch}</p>
          </div>
          <button className="btn subtle" onClick={onClose}>
            Close
          </button>
        </div>

        {!plan && !problem && <p className="muted">Reading the plan…</p>}
        {problem && <p className="warn">{problem}</p>}
        {plan && purpose && (
          <div className="brief-body">
            <Markdown text={purpose} />
          </div>
        )}
        {plan && !purpose && (
          <p className="muted">
            {plan.file
              ? 'Its plan does not say why, only what. The bench has the whole document.'
              : 'No plan in this worktree, so there is nothing here that says what it is for.'}
          </p>
        )}
      </div>
    </Overlay>
  );
}

/**
 * The back shelf: character first, name barely there. Tucked work stays visible
 * without competing for attention with what's actually in flight.
 */
export function TuckedSpecimen({
  specimen,
  onChanged,
}: {
  specimen: SpecimenView;
  onChanged: (updated: SpecimenView) => void;
}) {
  // No room for a bubble on the shelf, so a nudged plant raises its hand
  // instead; bringing it back to full size is where the asking happens.
  const nudge = nudgeFor(specimen);
  return (
    <button
      className={`tucked stage-${specimen.stage}${specimen.present ? '' : ' removed'}`}
      title={`${details(specimen)}${nudge ? `\n\n💬 ${nudge.text}` : ''}\n\nClick to bring it back to full size`}
      onClick={async () =>
        onChanged({ ...specimen, ...(await api.updateSpecimen(specimen.id, { minimized: false })) })
      }
    >
      {nudge && (
        <span className="tucked-nudge" aria-hidden="true">
          💬
        </span>
      )}
      <SproutAvatar seed={specimen.avatarSeed} stage={specimen.stage} size={62} />
      <span className="tucked-name">{shelfLabel(specimen.name)}</span>
    </button>
  );
}

/**
 * On the shelf, a leading TABLED- marker is redundant — the shelf says that —
 * and it swallows the part of the name that identifies the work.
 */
function shelfLabel(name: string): string {
  return name.replace(/^tabled[-_. ]+/i, '') || name;
}

/** “Sandbox, QA and Production” — the hover naming what the one tick covers. */
function listLabels(keys: Array<keyof Checklist>): string {
  const labels = keys.map((k) => CHECKS.find((c) => c.key === k)!.label);
  return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : labels.join('');
}

/**
 * The chip's text: the MR's number, qualified only when its state isn't the
 * default story — an open, ready-for-review MR just reads `MR !123`.
 */
function mrLabel(mr: MergeRequest): string {
  if (mr.state === 'opened') return mr.draft ? `draft !${mr.iid}` : `MR !${mr.iid}`;
  return `${mr.state} !${mr.iid}`;
}

/** GitLab's statuses, said the way a person would say them. */
const PIPE_WORD: Record<string, string> = {
  success: 'passed',
  failed: 'failed',
  running: 'running',
  pending: 'queued',
  created: 'queued',
  preparing: 'queued',
  waiting_for_resource: 'queued',
  manual: 'blocked',
  scheduled: 'scheduled',
  canceling: 'canceling',
  canceled: 'canceled',
  skipped: 'skipped',
};

/** Four colourings is enough: fine, broken, in motion, and nothing doing. */
const PIPE_TONE: Record<string, 'ok' | 'bad' | 'busy' | 'idle'> = {
  success: 'ok',
  failed: 'bad',
  canceled: 'bad',
  canceling: 'bad',
  running: 'busy',
  pending: 'busy',
  created: 'busy',
  preparing: 'busy',
  waiting_for_resource: 'busy',
  scheduled: 'busy',
  manual: 'idle',
  skipped: 'idle',
};

/**
 * The pipeline chip. Two facts, in the order they're wanted: whether the thing
 * is green, and whether it's waiting on a click. The second one wins the
 * colouring even on a green pipeline — a passed pipeline with an unplayed
 * deploy job is precisely the case where nothing is happening and nobody knows.
 */
function PipelineChip({ pipeline }: { pipeline: Pipeline }) {
  const waiting = pipeline.deploys.length;
  const tone = waiting > 0 ? 'waiting' : (PIPE_TONE[pipeline.status] ?? 'idle');
  const word = PIPE_WORD[pipeline.status] ?? pipeline.status.replace(/_/g, ' ');
  const noun = pipeline.kind === 'deploy' ? 'deploy' : 'pipeline';

  return (
    <a
      className={`pipe-link pipe-${tone}`}
      href={pipeline.url}
      target="_blank"
      rel="noreferrer"
      title={pipelineTitle(pipeline)}
    >
      {noun} {word}
      {waiting > 0 && <span className="pipe-count">▸ {waiting} waiting</span>}
      <span className="external" aria-hidden="true">
        ↗
      </span>
    </a>
  );
}

/** The hover: which pipeline this is, and the exact jobs still owed a click. */
function pipelineTitle(pipeline: Pipeline): string {
  // The checks pipeline's ref is `refs/merge-requests/N/merge` — plumbing, not
  // something to show anyone; the deploy pipeline's is a branch, worth naming.
  const what =
    pipeline.kind === 'deploy'
      ? `Deploy pipeline on ${pipeline.ref} — the one carrying this change`
      : 'Merge request pipeline — the checks standing between this and the merge';
  const jobs = pipeline.deploys
    .slice(0, 8)
    .map((j) => `  ${j.stage} · ${j.name}`)
    .concat(pipeline.deploys.length > 8 ? [`  …and ${pipeline.deploys.length - 8} more`] : []);
  return [
    what,
    `#${pipeline.id} · ${pipeline.status.replace(/_/g, ' ')} · updated ${new Date(pipeline.updatedAt).toLocaleString()}`,
    ...(jobs.length ? ['', 'Deployments waiting for a click:', ...jobs] : []),
    '',
    'Open the pipeline on GitLab (new tab)',
  ].join('\n');
}

/** Everything the headline leaves out, for the hover. */
function details(specimen: SpecimenView): string {
  const run = specimen.lastRun;
  const spent = run?.cost === null || run?.cost === undefined ? '' : ` · ${money(run.cost)}`;
  return [
    specimen.name,
    `branch: ${specimen.branch}`,
    `path: ${specimen.worktreePath}${specimen.present ? '' : ' (removed)'}`,
    `planted: ${new Date(specimen.createdAt).toLocaleString()}`,
    ...(specimen.plan ? [`plan: ${specimen.plan.file} — ${specimen.plan.done} of ${specimen.plan.total} steps`] : []),
    ...(run ? [`last run ${run.status} on ${new Date(run.at).toLocaleString()}${spent}`] : []),
    ...(specimen.mr ? [`MR !${specimen.mr.iid} (${specimen.mr.state}): ${specimen.mr.title}`] : []),
    ...(specimen.mr?.pipeline
      ? [
          `pipeline #${specimen.mr.pipeline.id} (${specimen.mr.pipeline.status})` +
            (specimen.mr.pipeline.deploys.length
              ? ` — ${specimen.mr.pipeline.deploys.length} deploys waiting on a click`
              : ''),
        ]
      : []),
  ].join('\n');
}

/**
 * Only worth saying where a worktree lives when it isn't in the usual nest
 * (`worktrees/<repo>/<name>`) — otherwise the path just repeats the heading.
 */
function locationHint(specimen: SpecimenView): string | null {
  const parent = specimen.worktreePath.slice(0, specimen.worktreePath.lastIndexOf('/'));
  if (parent.endsWith(`/worktrees/${specimen.repo}`)) return null;
  const parts = parent.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : `/${parts.join('/')}`;
}
