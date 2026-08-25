import { basename } from 'node:path';
import { isExcludedWorktree } from './discovery.ts';
import { newAvatarSeed, newSpecimenId, type SpecimenStore } from './state.ts';
import type {
  MergeRequest,
  PlanSummary,
  Pulse,
  RepoInfo,
  RepoSync,
  Specimen,
  SpecimenView,
  TerrariumView,
  WorktreeInfo,
} from './types.ts';

/**
 * Reconcile the state file against discovered reality (FR-2).
 *
 * - Worktree on disk with no record        -> new record (origin: discovered)
 * - Record whose worktree is gone          -> kept, flagged "worktree removed"
 * - Record matching an existing worktree   -> filesystem facts from disk,
 *                                             lifecycle facts from the state file
 *
 * Reconciliation never deletes lifecycle state. Excluded paths are hidden, not
 * dropped: the record stays in the file in case a pattern is removed later.
 */
export function reconcile(
  store: SpecimenStore,
  repos: RepoInfo[],
  excludeWorktreePatterns: string[] = [],
): Map<string, SpecimenView[]> {
  const byRepo = new Map<string, SpecimenView[]>();
  let mutated = false;

  for (const repo of repos) {
    const views: SpecimenView[] = [];
    const live = repo.worktrees.filter((wt) => !wt.isMain && !wt.bare);
    const activeRecords = store.specimens.filter(
      (s) =>
        s.repo === repo.name &&
        s.archivedAt === null &&
        !isExcludedWorktree(s.worktreePath, excludeWorktreePatterns),
    );
    const matched = new Set<Specimen>();
    const claimed = new Set<WorktreeInfo>();

    // Pass 1: exact worktree-path matches.
    for (const wt of live) {
      const record = activeRecords.find((s) => !matched.has(s) && s.worktreePath === wt.path);
      if (record) {
        matched.add(record);
        claimed.add(wt);
        if (wt.branch && record.branch !== wt.branch) {
          record.branch = wt.branch;
          mutated = true;
        }
        views.push(toView(record, wt));
      }
    }

    // Pass 2: a record whose old path vanished but whose branch reappeared at a
    // new path is the same specimen — adopt the new path rather than duplicating.
    // Only real directories are adopted; a stale git entry must not move a record.
    for (const wt of live) {
      if (claimed.has(wt) || !wt.exists) continue;
      const record = wt.branch
        ? activeRecords.find((s) => !matched.has(s) && s.branch === wt.branch)
        : undefined;
      if (record) {
        matched.add(record);
        claimed.add(wt);
        record.worktreePath = wt.path;
        mutated = true;
        views.push(toView(record, wt));
      }
    }

    // Pass 3: worktrees found *on disk* with no record are brand new (FR-2.1).
    // Stale git entries with no record are ignored — there is no lifecycle to keep.
    for (const wt of live) {
      if (claimed.has(wt) || !wt.exists) continue;
      const record: Specimen = {
        id: newSpecimenId(),
        repo: repo.name,
        branch: wt.branch ?? '(detached)',
        worktreePath: wt.path,
        createdAt: new Date().toISOString(),
        avatarSeed: newAvatarSeed(),
        checklist: { sandbox: false, qa: false, production: false },
        notes: '',
        origin: 'discovered',
        archivedAt: null,
        minimized: looksTabled(wt.path),
        planPath: null,
        lastRun: null,
      };
      store.specimens.push(record);
      mutated = true;
      views.push(toView(record, wt));
    }

    // Pass 4: records with no live worktree — the branch's lifecycle outlives it.
    for (const record of activeRecords) {
      if (!matched.has(record)) views.push(toView(record, null));
    }

    views.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    byRepo.set(repo.name, views);
  }

  // Records for repos that vanished entirely still must not be lost — surface
  // them under their recorded repo name.
  for (const record of store.specimens) {
    if (record.archivedAt !== null) continue;
    if (isExcludedWorktree(record.worktreePath, excludeWorktreePatterns)) continue;
    if (!byRepo.has(record.repo)) byRepo.set(record.repo, []);
    if (!repos.some((r) => r.name === record.repo)) {
      byRepo.get(record.repo)!.push(toView(record, null));
    }
  }

  if (mutated) store.save();
  return byRepo;
}

/**
 * One stage per box, so every tick moves the plant on: nothing checked is a
 * seedling, the third tick is the one that says it can be cut.
 */
export function stageOf(specimen: Specimen): SpecimenView['stage'] {
  const n = Number(specimen.checklist.sandbox) + Number(specimen.checklist.qa) + Number(specimen.checklist.production);
  return n === 0 ? 'seedling' : n === 1 ? 'growing' : n === 2 ? 'budding' : 'ready';
}

/** The folder name is what the developer named the work; the branch is git's business. */
export function worktreeName(path: string): string {
  return basename(path) || path;
}

/** Tabled work is parked, not abandoned — it starts life on the table. */
function looksTabled(path: string): boolean {
  return /^tabled[-_. ]/i.test(worktreeName(path));
}

function toView(record: Specimen, wt: WorktreeInfo | null): SpecimenView {
  // Presence follows the filesystem, not git's registry: a directory deleted
  // behind git's back is still listed (as prunable) but is gone for our purposes.
  return {
    ...record,
    name: worktreeName(record.worktreePath),
    present: wt?.exists === true,
    head: wt?.head ?? null,
    stage: stageOf(record),
    mr: null, // filled in from the MrTracker cache when the view is built
    plan: null, // read off disk when the view is built
    growing: false,
    pulse: null, // filled in from the live run, if there is one
  };
}

export function buildTerrariumView(
  repos: RepoInfo[],
  byRepo: Map<string, SpecimenView[]>,
  store: SpecimenStore,
  codeCliAvailable: boolean,
  syncOf: (repo: string) => RepoSync | null = () => null,
  mrOf: (repo: string, branch: string) => MergeRequest | null = () => null,
  planOf: (specimen: SpecimenView) => PlanSummary | null = () => null,
  pulseOf: (specimen: SpecimenView) => Pulse = () => null,
): TerrariumView {
  // The plan is read off disk here rather than cached: ralphex ticks its boxes
  // as the work lands, so a cached copy would be out of date the moment it
  // mattered. It is a few kilobytes per card.
  // Growing and the glow are the same fact read twice: a card is being worked
  // on exactly while its run is live, whether that run is busy or waiting on an
  // answer. A red glow is a run that has stopped, so it is not growing.
  const withMrs = (name: string, specimens: SpecimenView[]) =>
    specimens.map((s) => {
      const pulse = pulseOf(s);
      return { ...s, mr: mrOf(name, s.branch), plan: planOf(s), pulse, growing: pulse === 'working' || pulse === 'waiting' };
    });

  const repoViews = repos.map((repo) => ({
    name: repo.name,
    path: repo.path,
    error: repo.error,
    sync: syncOf(repo.name),
    specimens: withMrs(repo.name, byRepo.get(repo.name) ?? []),
  }));

  // Repos that no longer exist on disk but still have unarchived records.
  for (const [name, specimens] of byRepo) {
    if (!repos.some((r) => r.name === name) && specimens.length > 0) {
      repoViews.push({
        name,
        path: '',
        error: 'repository not found on disk',
        sync: null,
        specimens: withMrs(name, specimens),
      });
    }
  }

  return {
    repos: repoViews,
    archivedCount: store.specimens.filter((s) => s.archivedAt !== null).length,
    codeCliAvailable,
    generatedAt: new Date().toISOString(),
  };
}
