import { useEffect, useState } from 'react';
import { api, type RepoSyncState, type ResolveAction } from '../api.ts';
import { Overlay } from './Overlay.tsx';

/**
 * The other half of keeping default branches current: when the automatic pass
 * refuses to move `main` — because moving it would rewrite a local commit —
 * this is where a human sees exactly what is on each side and picks.
 *
 * Nothing here is silent. Both rewriting actions park the old branch tip on a
 * backup ref first, and the dialog names that ref afterwards.
 */
export function RepoSyncDialog({
  repo,
  onClose,
  onResolved,
}: {
  repo: string;
  onClose: () => void;
  onResolved: () => void;
}) {
  const [state, setState] = useState<RepoSyncState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ResolveAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    api.syncState(repo).then(setState, (err) => setLoadError((err as Error).message));
  }, [repo]);

  async function run(action: ResolveAction) {
    setBusy(action);
    setError(null);
    try {
      const result = await api.resolve(repo, action);
      setState(result.state);
      setMessage(result.message);
      setConfirmReset(false);
      onResolved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const branch = state?.defaultBranch ?? 'the default branch';
  const blockedByDirt = Boolean(state?.checkedOutIn && state.dirty);
  const level = Boolean(state && state.ahead === 0 && state.behind === 0);

  return (
    // Dismissing takes no action; a resolve already in flight holds it open.
    <Overlay onDismiss={() => !busy && onClose()}>
      <div className="dialog wide" role="dialog" aria-modal="true" aria-label={`${repo} versus origin`}>
        <div className="dialog-head">
          <div>
            <h3>{repo} — {branch} vs origin</h3>
            <p className="muted">
              Terrarium only ever fast-forwards on its own. Anything that would rewrite a local commit waits here for
              you.
            </p>
          </div>
        </div>

        {!state && !loadError && <p className="muted">Reading the branch…</p>}
        {loadError && <p className="warn">Could not read the repository: {loadError}</p>}

        {state && (
          <>
            <div className="sync-summary">
              <span className="chip">{state.ahead} local-only</span>
              <span className="chip subtle-chip">{state.behind} on origin only</span>
              {state.unrelated && <span className="chip warn-chip">no shared history</span>}
              {state.checkedOutIn && (
                <span className="chip subtle-chip" title={state.checkedOutIn}>
                  checked out in {folderName(state.checkedOutIn)}
                  {state.dirty ? ' (dirty)' : ''}
                </span>
              )}
            </div>

            {state.unrelated && (
              <p className="muted">
                These two branches have no commit in common — origin/{branch} was almost certainly created separately
                (the classic empty "Initial commit"). Rebasing replays your work on top of it; resetting throws your
                work away in favour of it.
              </p>
            )}

            <div className="commit-columns">
              <CommitColumn
                title={`Only on local ${branch}`}
                empty="Nothing — local is contained in origin."
                commits={state.local}
              />
              <CommitColumn
                title={`Only on origin/${branch}`}
                empty="Nothing — origin is contained in local."
                commits={state.remote}
              />
            </div>

            {state.ahead > 0 && blockedByDirt && (
              <p className="warn">
                {branch} is checked out in <code>{folderName(state.checkedOutIn!)}</code> with uncommitted changes.
                Commit or stash there first — Terrarium won't rewrite a branch out from under a dirty worktree.
              </p>
            )}

            {state.ahead === 0 && state.behind > 0 && (
              <div className="commit-column">
                <div className="commit-column-title">Blocked by uncommitted changes</div>
                <p className="muted">
                  Terrarium fast-forwards {branch} on its own; it's blocked because{' '}
                  {state.checkedOutIn ? folderName(state.checkedOutIn) : 'the checkout'} has uncommitted changes.
                </p>
                {state.dirtyFiles.length > 0 && (
                  <ul>
                    {state.dirtyFiles.map((f) => (
                      <li key={f}>
                        <code>{f}</code>
                      </li>
                    ))}
                    {state.dirtyCount > state.dirtyFiles.length && (
                      <li className="muted">{state.dirtyCount - state.dirtyFiles.length} more…</li>
                    )}
                  </ul>
                )}
              </div>
            )}

            {level && <p className="muted">{branch} is level with origin/{branch} — nothing to do here.</p>}

            {state.backups.length > 0 && (
              <details className="backups">
                <summary>
                  {state.backups.length} earlier backup{state.backups.length === 1 ? '' : 's'} of {branch}
                </summary>
                <ul>
                  {state.backups.map((b) => (
                    <li key={b.ref}>
                      <code>{b.sha}</code> {b.subject}
                      <div className="muted">
                        <code>git branch recovered-{branch.replace(/\W+/g, '-')} {b.ref}</code>
                      </div>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {message && <p className="notice inline">✅ {message}</p>}
            {error && <p className="warn">{error}</p>}

            {!level && (
              <div className="dialog-actions spread">
                <button className="btn subtle" onClick={() => void run('fetch')} disabled={busy !== null}>
                  {busy === 'fetch' ? 'Fetching…' : 'Fetch again'}
                </button>
                <div className="spacer" />
                {state.ahead > 0 &&
                  (confirmReset ? (
                    <>
                      <button className="btn subtle" onClick={() => setConfirmReset(false)} disabled={busy !== null}>
                        Cancel
                      </button>
                      <button className="btn danger" onClick={() => void run('reset')} disabled={busy !== null}>
                        {busy === 'reset'
                          ? 'Resetting…'
                          : `Yes, drop ${state.ahead} local commit${state.ahead === 1 ? '' : 's'}`}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="btn danger-outline"
                        onClick={() => setConfirmReset(true)}
                        disabled={blockedByDirt || busy !== null}
                        title={`Point ${branch} at origin/${branch}. Your local commits stay reachable on a backup ref.`}
                      >
                        Reset to origin
                      </button>
                      <button
                        className="btn primary"
                        onClick={() => void run('rebase')}
                        disabled={blockedByDirt || busy !== null}
                        title={`Replay your ${state.ahead} local commit${
                          state.ahead === 1 ? '' : 's'
                        } on top of origin/${branch}. Conflicts abort cleanly.`}
                      >
                        {busy === 'rebase' ? 'Rebasing…' : 'Rebase onto origin'}
                      </button>
                    </>
                  ))}
              </div>
            )}

            <div className="dialog-actions">
              {!level && (
                <>
                  <button className="btn subtle" onClick={() => void api.openPath(state.path)} disabled={!state.path}>
                    Open repo in VS Code
                  </button>
                  <div className="spacer" />
                </>
              )}
              <button className="btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

function CommitColumn({
  title,
  commits,
  empty,
}: {
  title: string;
  commits: Array<{ sha: string; subject: string }>;
  empty: string;
}) {
  return (
    <div className="commit-column">
      <div className="commit-column-title">{title}</div>
      {commits.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul>
          {commits.map((c) => (
            <li key={c.sha}>
              <code>{c.sha}</code> {c.subject}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function folderName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}
