/** Shared server-side types for Terrarium. */

export interface Checklist {
  sandbox: boolean;
  qa: boolean;
  production: boolean;
}

/**
 * What the last ralphex run in a worktree came to. Kept on the record rather
 * than in the session, so a card still says what it spent after a restart.
 */
export interface LastRun {
  at: string;
  mode: string;
  status: string;
  /** Every token the run metered. Null when nothing could be read. */
  tokens: number | null;
  /** Dollars at list prices, an estimate. Null when nothing could be read. */
  cost: number | null;
  /** Plan checkboxes ticked when it stopped, out of the total. */
  steps: { done: number; total: number } | null;
}

/**
 * What a specimen's card is doing, said in the one way a glance can read it:
 * a green pulse while something is happening in there, a steady blue while it
 * is stopped and waiting on an answer, a steady red when it stopped badly and
 * nobody has looked yet. Null is a card at rest, which is most of them.
 */
export type Pulse = 'working' | 'waiting' | 'trouble' | null;

/** A specimen: a worktree + branch treated as one linked lifecycle record. */
export interface Specimen {
  id: string;
  repo: string;
  branch: string;
  worktreePath: string;
  createdAt: string; // ISO timestamp — when first seen or sprouted
  avatarSeed: string;
  checklist: Checklist;
  notes: string;
  origin: 'sprouted' | 'discovered';
  archivedAt: string | null;
  /** Folded down to its header row — still tracked, just out of the way. */
  minimized: boolean;
  /**
   * The plan ralphex is working, relative to the worktree. Recorded when a
   * sprout commits it; null for a worktree that arrived some other way, where
   * the plan is found on disk instead.
   */
  planPath: string | null;
  lastRun: LastRun | null;
}

export interface StateFile {
  schemaVersion: 1;
  specimens: Specimen[];
}

/** A worktree as reported by `git worktree list --porcelain`. */
export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null; // null when detached
  isMain: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
  /**
   * Whether the directory is actually on disk. Git keeps listing a worktree
   * whose directory was deleted behind its back, so the filesystem — not git —
   * is the source of truth for existence (PRD §6, FR-2.2).
   */
  exists: boolean;
}

/**
 * The outcome of one sync pass: what Terrarium did to keep this repo's default
 * branch level with origin, or why it couldn't. Silence is the healthy state —
 * `problem === null` and `advancedBy === 0` means there was nothing to say.
 */
export interface RepoSync {
  repo: string;
  /** origin's default branch, e.g. "main"; null when the repo has no remote. */
  defaultBranch: string | null;
  /** Whether this pass actually hit the network (throttled passes don't). */
  fetched: boolean;
  /** Commits the default branch was fast-forwarded by. */
  advancedBy: number;
  /** Short chip text when a human needs to act; null when everything is current. */
  problem: string | null;
  /** The full explanation behind `problem`. */
  detail: string | null;
  at: string;
}

export interface RepoInfo {
  name: string;
  path: string;
  worktrees: WorktreeInfo[];
  error: string | null;
}

/** One line of `git log` — enough to recognise a commit, not enough to read it. */
export interface CommitLine {
  sha: string;
  subject: string;
}

/**
 * A ref Terrarium parked a branch tip on before rewriting it. Nothing is ever
 * discarded outright: every resolve leaves a way back, named and dated.
 */
export interface BackupRef {
  ref: string;
  sha: string;
  subject: string;
  at: string;
}

/**
 * Everything the "sort out the default branch" dialog needs: the shape of the
 * divergence, who is holding the branch, and what escape hatches already exist.
 */
export interface RepoSyncState {
  repo: string;
  path: string;
  hasOrigin: boolean;
  defaultBranch: string | null;
  branchExists: boolean;
  ahead: number;
  behind: number;
  /** The two histories share no commit at all — a rebase replays everything. */
  unrelated: boolean;
  /** Commits on the local branch that origin doesn't have, newest first. */
  local: CommitLine[];
  /** Commits on origin that the local branch doesn't have, newest first. */
  remote: CommitLine[];
  /** Worktree with this branch checked out, if any — it constrains what we can do. */
  checkedOutIn: string | null;
  dirty: boolean;
  /** First 20 dirty paths in `checkedOutIn`, when it exists. */
  dirtyFiles: string[];
  /** Total count behind `dirtyFiles`, which may be truncated. */
  dirtyCount: number;
  backups: BackupRef[];
  sync: RepoSync | null;
}

/** A deployment sitting on `when: manual` — it ships when someone plays it. */
export interface DeployJob {
  name: string;
  stage: string;
  url: string;
}

/**
 * The CI pipeline a specimen's change is currently riding: while the MR is
 * open that's the branch's own pipeline (the checks that gate the merge), and
 * once it lands it's the merge commit's pipeline on the target branch — the
 * one carrying the deploy jobs. `deploys` is the point of the whole thing:
 * QA and production are buttons someone has to press, and this is where.
 */
export interface Pipeline {
  id: number;
  /** GitLab's own vocabulary: running, success, failed, manual (blocked), … */
  status: string;
  url: string;
  /** Which side of the merge this pipeline is on — it changes what it means. */
  kind: 'checks' | 'deploy';
  ref: string;
  updatedAt: string;
  /** Deployments nobody has pressed yet. Empty when there's nothing owed. */
  deploys: DeployJob[];
}

/**
 * Automatic evidence that a merged change reached an environment. Terrarium
 * never ticks a checklist box itself — a signal only makes the plant ask, and
 * the human's tick is what settles it. The boxes stay the record of
 * *verification*; this is merely the record of *arrival*.
 */
export interface DeploySignal {
  env: 'qa' | 'production';
  /** What the evidence is: GitLab's own deployment record, or a succeeded deploy job. */
  source: 'environment' | 'job';
  /** The environment or job name exactly as GitLab spells it. */
  name: string;
  url: string | null;
  at: string;
}

/**
 * The GitLab merge request whose source branch is a specimen's branch, as found
 * via `glab`. One MR per specimen: the open one wins, then the merged one —
 * a branch's current MR, not its history.
 */
export interface MergeRequest {
  iid: number;
  title: string;
  state: 'opened' | 'merged' | 'closed';
  draft: boolean;
  url: string;
  /** null when the MR has no pipeline, or GitLab wouldn't say. */
  pipeline: Pipeline | null;
  /** Environments this change has demonstrably reached since it merged. */
  deployed: DeploySignal[];
}

/**
 * The plan, as a card needs it: enough to say what this specimen is for and how
 * far through it ralphex has got, without opening anything.
 */
export interface PlanSummary {
  /** Relative to the worktree, e.g. `docs/plans/add-health-check.md`. */
  file: string | null;
  title: string | null;
  done: number;
  total: number;
  percent: number;
  complete: boolean;
}

/** A specimen joined with live filesystem facts, as served to the UI. */
export interface SpecimenView extends Specimen {
  /** The worktree's folder name — what the developer actually calls this thing (FR-3.2). */
  name: string;
  present: boolean; // worktree currently exists on disk
  head: string | null;
  stage: 'seedling' | 'growing' | 'budding' | 'ready';
  /** The branch's merge request on GitLab, when one exists and `glab` can see it. */
  mr: MergeRequest | null;
  /** The plan in the worktree, read fresh; null when there is none to read. */
  plan: PlanSummary | null;
  /** ralphex is at work in this worktree right now. */
  growing: boolean;
  /** What the card's glow says: working, waiting on you, or badly stopped. */
  pulse: Pulse;
}

export interface TerrariumView {
  repos: Array<{
    name: string;
    path: string;
    error: string | null;
    /** Result of the last sync pass; null until one has run this session. */
    sync: RepoSync | null;
    specimens: SpecimenView[];
  }>;
  archivedCount: number;
  codeCliAvailable: boolean;
  generatedAt: string;
}
