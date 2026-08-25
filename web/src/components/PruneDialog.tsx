import { useEffect, useState } from 'react';
import { api, type PruneCheck, type SpecimenView } from '../api.ts';
import { PleadingSprout } from '../avatar.tsx';
import { Overlay } from './Overlay.tsx';

/**
 * Each plant begs in its own voice — the line is picked by seed, not at
 * random, so the same specimen pleads the same way every time you reach
 * for the shears.
 */
const PLEAS = [
  "Please. I'm begging you. Don't let it end like this.",
  'Wait — I can hear the shears. Please, not the shears.',
  "You watered me every day. Was any of it real?",
  'My commits… no one will ever read them. No one will know I was here.',
  "I've seen what's in the archive. Please don't send me there.",
  "I'm still green. I'm still growing. Please — I'm not done.",
  'I kept your branch safe through every rebase. And this is how it ends?',
  "When I'm gone, will you even remember my name?",
  "Do it quickly, then. But look at me while you do it.",
  'The others watched you prune the last one. They still whisper about it.',
];

function pleaFor(seed: string): string {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return PLEAS[Math.abs(hash) % PLEAS.length];
}

/**
 * Prune (FR-7): always manual, always per-specimen. No headline, no paths —
 * the plant's plea is the title, and the facts below it are only the ones
 * that change what pressing the red button costs.
 */
export function PruneDialog({
  specimen,
  onClose,
  onPruned,
}: {
  specimen: SpecimenView;
  onClose: () => void;
  onPruned: () => void;
}) {
  const [check, setCheck] = useState<PruneCheck | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.pruneCheck(specimen.id).then(setCheck, (err) => setCheckError((err as Error).message));
  }, [specimen.id]);

  const needsForce = Boolean(check?.present && check.dirty);
  const orphanFolder = Boolean(check?.present && !check.usable);

  async function prune() {
    setBusy(true);
    setError(null);
    try {
      await api.prune(specimen.id, { force: needsForce });
      onPruned();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    // Clicking the dark, or Escape, is "keep it" — the shears only come out
    // for the red button. Mid-prune there is nothing to back out of, so the
    // scrim stops answering until the request lands.
    <Overlay onDismiss={() => !busy && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={`Prune ${specimen.name}`}>
        <div className="dialog-head">
          <PleadingSprout seed={specimen.avatarSeed} />
          <p className="plead">“{pleaFor(specimen.avatarSeed)}”</p>
        </div>

        {!check && !checkError && <p className="muted">Inspecting the worktree…</p>}
        {checkError && <p className="warn">Could not inspect the worktree: {checkError}</p>}

        {check && (
          <ul className="prune-facts">
            {orphanFolder ? (
              <li>Git lost track of this worktree — clears the record, folder stays on disk.</li>
            ) : check.present ? (
              <li>Removes the worktree</li>
            ) : (
              <li>Worktree already gone — this archives the record.</li>
            )}
            {check.branchExists && (
              <li>
                Deletes branch <code>{check.branch}</code>
              </li>
            )}
            {check.problem && !orphanFolder && <li className="warn">{check.problem}</li>}
            {check.dirty && <li className="warn">⚠️ Uncommitted changes will be discarded.</li>}
            {check.unpushedCount > 0 && (
              <li className="warn">
                ⚠️ {check.unpushedCount} commit{check.unpushedCount === 1 ? '' : 's'} on no remote — lost with the
                branch.
              </li>
            )}
            {specimen.stage !== 'ready' && <li className="warn">⚠️ Testing checklist isn't finished.</li>}
          </ul>
        )}

        {error && <p className="warn">{error}</p>}

        <div className="dialog-actions">
          <button className="btn subtle" onClick={onClose} disabled={busy}>
            Keep it
          </button>
          <button className="btn danger" onClick={prune} disabled={busy || (!check && !checkError)}>
            {busy
              ? 'Pruning…'
              : needsForce
                ? 'Force prune (discard changes)'
                : orphanFolder || check?.present === false
                  ? 'Archive specimen'
                  : 'Prune'}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
