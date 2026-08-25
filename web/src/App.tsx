import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type AppVersion,
  type RepoSync,
  type RepoView,
  type SpecimenView,
  type TerrariumView,
  type UpdateInfo,
} from './api.ts';
import { CardColumns } from './components/CardColumns.tsx';
import { SpecimenCard, TuckedSpecimen } from './components/SpecimenCard.tsx';
import { PruneDialog } from './components/PruneDialog.tsx';
import { RepoSyncDialog } from './components/RepoSyncDialog.tsx';
import { SproutFlow } from './components/SproutFlow.tsx';
import { Archive } from './components/Archive.tsx';
import { DoctorDialog } from './components/DoctorDialog.tsx';
import { ThemePill } from './theme.tsx';

/** Which sections the developer folded away, kept across reloads. */
const COLLAPSED_KEY = 'terrarium.collapsedRepos';

function loadCollapsed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return new Set();
  }
}

export function App() {
  const [view, setView] = useState<TerrariumView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [pruneTarget, setPruneTarget] = useState<SpecimenView | null>(null);
  const [sproutRepo, setSproutRepo] = useState<string | null>(null);
  const [sproutOpen, setSproutOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [syncRepo, setSyncRepo] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [query, setQuery] = useState('');
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [repot, setRepot] = useState<{ phase: 'idle' | 'applying' | 'waiting' | 'stalled'; message: string | null }>({
    phase: 'idle',
    message: null,
  });

  const toggleCollapsed = useCallback((repo: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setView(await api.terrarium());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, []);

  /**
   * Fetch origin and fast-forward each repo's default branch, then re-read. The
   * view is painted from local state first and updated when this lands, so a
   * slow remote never holds up the glass.
   */
  const syncAndRefresh = useCallback(
    async (force: boolean) => {
      // Refresh means "sync everything" — the dashboard's own update check
      // rides along, best-effort.
      if (force) void api.updateCheck().then(setUpdate).catch(() => {});
      setSyncing(true);
      try {
        await api.sync(force);
        setSyncError(null);
      } catch (err) {
        setSyncError((err as Error).message);
      } finally {
        setSyncing(false);
      }
      await refresh();
    },
    [refresh],
  );

  useEffect(() => {
    void refresh().then(() => syncAndRefresh(false));
  }, [refresh, syncAndRefresh]);

  // A tab left open all day drifts otherwise — same throttled pass as page
  // load and Refresh, just on a timer.
  useEffect(() => {
    const timer = setInterval(() => void syncAndRefresh(false), 5 * 60_000);
    return () => clearInterval(timer);
  }, [syncAndRefresh]);

  // While something is being worked on, its plan's checkboxes are being ticked
  // under us, and that is the one thing on the shelf that moves by itself. No
  // network in this pass: it re-reads the local scan, nothing else.
  const anyGrowing = view?.repos.some((repo) => repo.specimens.some((s) => s.growing)) ?? false;
  useEffect(() => {
    if (!anyGrowing) return;
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [anyGrowing, refresh]);

  // The server checks its own origin on a timer; the page just reads the
  // cached answer now and then, so a banner appears without a reload.
  useEffect(() => {
    const look = () => api.updateStatus().then(setUpdate).catch(() => {});
    void look();
    const timer = setInterval(look, 15 * 60_000);
    return () => clearInterval(timer);
  }, []);

  /**
   * Repot: apply the update, then wait for a *different* server process to
   * answer before reloading — the old one is gone on purpose, so fetch
   * failures along the way are part of the plan, not errors.
   */
  const repotNow = useCallback(async () => {
    if (!update) return;
    setRepot({ phase: 'applying', message: null });
    try {
      const result = await api.updateApply();
      if (!result.restarting) {
        setRepot({ phase: 'stalled', message: result.message });
        return;
      }
      setRepot({ phase: 'waiting', message: null });
      if (await waitForNewBoot(update.bootId)) {
        location.reload();
      } else {
        setRepot({
          phase: 'stalled',
          message: 'The terrarium never came back. Check the terminal it runs in (or data/agent.log), then reload this page.',
        });
      }
    } catch (err) {
      setRepot({ phase: 'stalled', message: (err as Error).message });
    }
  }, [update]);

  const specimenChanged = useCallback((updated: SpecimenView) => {
    setView((prev) =>
      prev
        ? {
            ...prev,
            repos: prev.repos.map((r) => ({
              ...r,
              specimens: r.specimens.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)),
            })),
          }
        : prev,
    );
  }, []);

  const totalSpecimens = view?.repos.reduce((n, r) => n + r.specimens.length, 0) ?? 0;
  const sproutableRepos = view?.repos.filter((r) => !r.error && r.path).map((r) => r.name) ?? [];
  const canSprout = Boolean(view?.sproutEnabled && view.doctor?.ready);
  const filtering = query.trim().length > 0;

  /**
   * Search happens here rather than per section, so the counts in the repo
   * headers and the toolbar are talking about the same thing. The order is
   * newest-first and fixed: cards come and go from the shelf all day, and
   * nothing is worse than the shelf rearranging itself under the cursor.
   */
  const shownRepos = useMemo(() => {
    if (!view) return [];
    const needle = query.trim().toLowerCase();
    const repoMatches = (repo: RepoView) => needle.length > 0 && repo.name.toLowerCase().includes(needle);

    return view.repos
      .map((repo) => {
        const specimens = repo.specimens
          .filter((s) => !needle || repoMatches(repo) || matches(s, needle))
          .sort(byPlanted);
        return { ...repo, specimens };
      })
      .filter((repo) => !filtering || repo.specimens.length > 0 || repoMatches(repo));
  }, [view, query, filtering]);

  const shownSpecimens = shownRepos.reduce((n, r) => n + r.specimens.length, 0);

  return (
    <div className="terrarium">
      {/* Sticky: Refresh and Sprout are the two things you reach for mid-scroll. */}
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">🪴</span>
          <div className="brand-text">
            <h1>Terrarium</h1>
            <p className="tagline">a small, sealed world of growing worktrees</p>
          </div>
        </div>
        <div className="topbar-actions">
          <ThemePill />
          <button
            className="btn"
            onClick={() => void syncAndRefresh(true)}
            disabled={refreshing || syncing}
            title="Fetch origin, bring each repo's default branch up to date, then re-scan"
          >
            {syncing ? 'Syncing…' : refreshing ? 'Scanning…' : '↻ Refresh'}
          </button>
          <button
            className="btn"
            onClick={() => setArchiveOpen(true)}
            title="Specimens that have already been pruned, kept as a record"
          >
            🍂 Pruned{view ? ` (${view.archivedCount})` : ''}
          </button>
          <button
            className="btn primary"
            onClick={() => setSproutOpen(true)}
            disabled={!canSprout || sproutableRepos.length === 0}
            title={
              view && !view.sproutEnabled
                ? 'Growing is switched off in terrarium.config.json.'
                : view && !view.doctor?.ready
                  ? `Not installed: ${view.doctor.missingRequired.join(' and ')} — everything else still works.`
                  : 'Grow a new worktree: describe the work, and the plan writes itself'
            }
          >
            🌱 Sprout
          </button>
        </div>
      </header>

      {view && !view.sproutEnabled && (
        <div className="notice">
          Growing is switched off, so Sprout does nothing and the bench cannot start a run. The rest of the Terrarium
          works as usual.
        </div>
      )}

      {view && view.sproutEnabled && !view.doctor?.ready && (
        <div className="notice missing-notice">
          <span>
            {view.doctor.missingRequired.join(' and ')} {view.doctor.missingRequired.length > 1 ? 'are' : 'is'} not on
            this machine, so nothing can be grown. The rest of the Terrarium works as usual.
          </span>
          <button className="btn" onClick={() => setDoctorOpen(true)}>
            What to install
          </button>
        </div>
      )}

      {/* The dashboard's own update. Fetched already (the check is the
          download); nothing applies itself — the button does. */}
      {update?.status.state === 'ready' && repot.phase !== 'stalled' && (
        <div className="notice update-notice">
          <span title={update.status.commits.map((c) => `${c.sha} ${c.subject}`).join('\n')}>
            🌿 New growth is ready — this dashboard is {update.status.behind} commit
            {update.status.behind === 1 ? '' : 's'} behind its origin.
          </span>
          <button
            className="btn primary"
            onClick={() => void repotNow()}
            disabled={repot.phase !== 'idle'}
            title="Pull the update, rebuild what changed, and restart. The page reloads itself."
          >
            {repot.phase === 'applying' ? 'Repotting…' : repot.phase === 'waiting' ? 'Coming back up…' : '🪴 Repot the terrarium'}
          </button>
        </div>
      )}
      {update?.status.state === 'blocked' && update.status.behind > 0 && (
        <div className="notice">
          🌿 An update is waiting ({update.status.behind} commit{update.status.behind === 1 ? '' : 's'}), but{' '}
          {update.status.reason}.
        </div>
      )}
      {repot.phase === 'stalled' && repot.message && <div className="notice warn">{repot.message}</div>}

      {error && <div className="notice warn">Could not load the Terrarium: {error}</div>}
      {syncError && <div className="notice warn">Could not sync with origin: {syncError}</div>}
      {!view && !error && <div className="notice">Peering into the glass…</div>}

      {view && totalSpecimens > 0 && (
        <div className="toolbar">
          <div className="search">
            <span className="search-icon" aria-hidden="true">
              🔍
            </span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search worktrees, branches, repos…"
              aria-label="Search specimens by worktree, branch or repository"
            />
          </div>
          <span className="toolbar-count" role="status">
            {filtering ? `${shownSpecimens} of ${totalSpecimens}` : `${totalSpecimens}`} specimen
            {totalSpecimens === 1 ? '' : 's'}
          </span>
        </div>
      )}

      {view && totalSpecimens === 0 && (
        // Nothing planted yet, so the page shows the ground it would go in.
        <div className="empty-state field">
          <h2>Just a patch of soil so far</h2>
          <p>
            Nothing growing in {view.repos.length} {view.repos.length === 1 ? 'repository' : 'repositories'}.{' '}
            {canSprout ? (
              <>
                Press <strong>Sprout</strong> to plant something.
              </>
            ) : (
              'Make a worktree with git and it shows up here.'
            )}
          </p>
        </div>
      )}

      {view && totalSpecimens > 0 && filtering && shownSpecimens === 0 && (
        <div className="empty-state">
          <h2>Nothing matches</h2>
          <p className="muted">
            No specimen answers to that.{' '}
            <button className="linkish" onClick={() => setQuery('')}>
              Clear the search
            </button>
          </p>
        </div>
      )}

      {/* Every discovered repo gets a section, specimens or not — a repo you
          just cloned has to be visible before it can grow anything. */}
      {shownRepos.map((repo) => {
        const isCollapsed = collapsed.has(repo.name);
        const total = view?.repos.find((r) => r.name === repo.name)?.specimens.length ?? repo.specimens.length;
        const bare = total === 0 && !repo.error;
        return (
          <section key={repo.name} className={`repo-section${isCollapsed ? ' collapsed' : ''}${bare ? ' bare' : ''}`}>
            <div className="repo-head">
              <h2>
                <button
                  className="repo-toggle"
                  onClick={() => toggleCollapsed(repo.name)}
                  aria-expanded={!isCollapsed}
                  title={isCollapsed ? 'Show this repository' : 'Fold this repository away'}
                >
                  <span className={`caret${isCollapsed ? ' shut' : ''}`} aria-hidden="true">
                    ▾
                  </span>
                  <span className="repo-name">{repo.name}</span>
                  <span className="repo-count">
                    {repo.specimens.length === total ? total : `${repo.specimens.length}/${total}`}
                  </span>
                </button>
              </h2>
              {repo.sync && <SyncStatus sync={repo.sync} onOpen={() => setSyncRepo(repo.name)} />}
              {repo.error && (
                <span className="chip error-chip" title={repo.error}>
                  ⚠ scan failed
                </span>
              )}
              {/* An empty repo is a single line, not a section with a header
                  and one sentence under it. */}
              {bare && (
                <span className="repo-empty muted">
                  No worktrees yet — just the main checkout.{' '}
                  {repo.path && canSprout && (
                    <button
                      className="linkish"
                      onClick={() => {
                        setSproutRepo(repo.name);
                        setSproutOpen(true);
                      }}
                    >
                      Sprout one here
                    </button>
                  )}
                </span>
              )}
            </div>

            {!isCollapsed && repo.specimens.some((s) => !s.minimized) && (
              <CardColumns items={repo.specimens.filter((s) => !s.minimized)} itemKey={(s) => s.id}>
                {(s) => <SpecimenCard specimen={s} onChanged={specimenChanged} onPrune={setPruneTarget} />}
              </CardColumns>
            )}
            {/* The back shelf lives with its repo: tucked specimens sit in a
                dashed tray right under the grid, not at the far end of the page. */}
            {!isCollapsed && repo.specimens.some((s) => s.minimized) && (
              <div className="tucked-shelf">
                <span className="shelf-label" title="Tucked away — still tracked, just not in the way">
                  tucked
                </span>
                {repo.specimens
                  .filter((s) => s.minimized)
                  .map((s) => (
                    <TuckedSpecimen key={s.id} specimen={s} onChanged={specimenChanged} />
                  ))}
              </div>
            )}
          </section>
        );
      })}

      {pruneTarget && (
        <PruneDialog
          specimen={pruneTarget}
          onClose={() => setPruneTarget(null)}
          onPruned={() => {
            setPruneTarget(null);
            void refresh();
          }}
        />
      )}

      {sproutOpen && (
        <SproutFlow
          repos={sproutableRepos}
          initialRepo={sproutRepo}
          onClose={() => {
            setSproutOpen(false);
            setSproutRepo(null);
          }}
          onFinished={() => {
            setSproutOpen(false);
            setSproutRepo(null);
            void refresh();
          }}
        />
      )}

      {syncRepo && (
        <RepoSyncDialog
          repo={syncRepo}
          onClose={() => setSyncRepo(null)}
          onResolved={() => void refresh()}
        />
      )}

      {archiveOpen && <Archive onClose={() => setArchiveOpen(false)} />}

      {doctorOpen && <DoctorDialog onClose={() => setDoctorOpen(false)} />}

      {/* The only line on the page about Terrarium itself rather than what is
          growing in it: which copy you are looking at, and when it last moved. */}
      {update && <VersionLine version={update.version} />}
    </div>
  );
}

/**
 * The patch number counts commits, so it goes up on its own with every push —
 * two people comparing footers know instantly whether they are on the same
 * code, and nobody has to remember to bump anything.
 */
function VersionLine({ version }: { version: AppVersion }) {
  const when = version.updatedAt ? new Date(version.updatedAt) : null;
  const title = [version.commit && `commit ${version.commit}`, when && `updated ${when.toLocaleString()}`]
    .filter(Boolean)
    .join(' · ');
  return (
    <footer className="version" title={title || undefined}>
      {version.label}
      {when && ` · ${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`}
    </footer>
  );
}

/**
 * Knock every second until a different server process answers. The gap while
 * nothing answers is the restart itself, so errors here mean "keep knocking",
 * not "give up" — up to a point.
 */
async function waitForNewBoot(oldBootId: string): Promise<boolean> {
  for (let i = 0; i < 90; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    try {
      if ((await api.updateStatus()).bootId !== oldBootId) return true;
    } catch {
      // mid-restart — expected
    }
  }
  return false;
}

/** Search covers everything you'd plausibly remember a specimen by. */
function matches(specimen: SpecimenView, needle: string): boolean {
  return (
    specimen.name.toLowerCase().includes(needle) ||
    specimen.branch.toLowerCase().includes(needle) ||
    specimen.repo.toLowerCase().includes(needle) ||
    specimen.notes.toLowerCase().includes(needle)
  );
}

/**
 * Newest first, and nothing else — a specimen's position is decided the moment
 * it's planted and never moves again. Folding a card, ticking a box or ripening
 * a stage all leave the shelf exactly where it was.
 */
function byPlanted(a: SpecimenView, b: SpecimenView): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

/**
 * A repo header only speaks up when something needs a human. A fast-forward
 * that already happened is not news: there is nothing to decide and nothing
 * left to look at, so it gets no chip. Every chip here is a job, and clicking
 * it is how you do that job.
 */
function SyncStatus({ sync, onOpen }: { sync: RepoSync; onOpen: () => void }) {
  if (!sync.problem) return null;
  return (
    <button
      className="chip warn-chip actionable"
      onClick={onOpen}
      title={`${sync.detail ?? sync.problem}\n\nClick to see both sides and resolve it.`}
    >
      ⚠ {sync.problem} →
    </button>
  );
}
