/** Typed client for the Terrarium API. */

export interface Checklist {
  sandbox: boolean;
  qa: boolean;
  production: boolean;
}

/** A deployment sitting on `when: manual` — it ships when someone plays it. */
export interface DeployJob {
  name: string;
  stage: string;
  url: string;
}

/**
 * The pipeline the change is riding: the branch's checks while the MR is open,
 * the merge commit's deploy pipeline once it lands. `deploys` is what's waiting
 * on a human — the clicks through to QA and production.
 */
export interface Pipeline {
  id: number;
  /** GitLab's vocabulary: running, success, failed, manual (blocked), … */
  status: string;
  url: string;
  kind: 'checks' | 'deploy';
  ref: string;
  updatedAt: string;
  deploys: DeployJob[];
}

/**
 * Automatic evidence that a merged change reached an environment. Never ticks
 * a box — it only makes the plant ask; the human's tick settles it.
 */
export interface DeploySignal {
  env: 'qa' | 'production';
  /** GitLab's own deployment record, or a succeeded deploy job on the change's pipeline. */
  source: 'environment' | 'job';
  /** The environment or job name exactly as GitLab spells it. */
  name: string;
  url: string | null;
  at: string;
}

/** The branch's merge request on GitLab, when one exists and `glab` can see it. */
export interface MergeRequest {
  iid: number;
  title: string;
  state: 'opened' | 'merged' | 'closed';
  draft: boolean;
  url: string;
  pipeline: Pipeline | null;
  /** Environments this change has demonstrably reached since it merged. */
  deployed: DeploySignal[];
}

/** One stage per checkbox: none, one, two, all three. */
export type Stage = 'seedling' | 'growing' | 'budding' | 'ready';

/**
 * What something on the glass is doing, said the way a glance reads it: a
 * green pulse while it is working, a steady blue while it is stopped and
 * waiting on you, a steady red when it stopped badly. Null is at rest.
 */
export type Pulse = 'working' | 'waiting' | 'trouble' | null;

/**
 * The plan, boiled down to what a card shows: what the work is called, and how
 * many of its steps have been ticked off.
 */
export interface PlanSummary {
  file: string | null;
  title: string | null;
  done: number;
  total: number;
  percent: number;
  complete: boolean;
}

/** What the last run in this worktree came to. */
export interface LastRun {
  at: string;
  mode: string;
  status: string;
  tokens: number | null;
  /** Dollars at list prices, an estimate. Null when nothing could be read. */
  cost: number | null;
  steps: { done: number; total: number } | null;
}

export interface SpecimenView {
  id: string;
  /** Worktree folder name — the card's headline. */
  name: string;
  repo: string;
  branch: string;
  worktreePath: string;
  createdAt: string;
  avatarSeed: string;
  checklist: Checklist;
  notes: string;
  origin: 'sprouted' | 'discovered';
  archivedAt: string | null;
  /** Folded down to its header row — still tracked, just out of the way. */
  minimized: boolean;
  present: boolean;
  head: string | null;
  stage: Stage;
  mr: MergeRequest | null;
  /** The plan being worked in this worktree, relative to it. */
  planPath: string | null;
  plan: PlanSummary | null;
  lastRun: LastRun | null;
  /** Something is at work in this worktree right now. */
  growing: boolean;
  /** What the card's glow says: working, waiting on you, or badly stopped. */
  pulse: Pulse;
}

/** What the last sync pass did to keep this repo level with origin. */
export interface RepoSync {
  repo: string;
  defaultBranch: string | null;
  fetched: boolean;
  advancedBy: number;
  /** Short chip text when a human needs to act; null when everything is current. */
  problem: string | null;
  detail: string | null;
  at: string;
}

export interface RepoView {
  name: string;
  path: string;
  error: string | null;
  sync: RepoSync | null;
  specimens: SpecimenView[];
}

export interface TerrariumView {
  repos: RepoView[];
  archivedCount: number;
  sproutEnabled: boolean;
  codeCliAvailable: boolean;
  doctor: DoctorReport;
  generatedAt: string;
}

/** What has to be installed before anything can grow. */
export interface ToolCheck {
  id: string;
  label: string;
  required: boolean;
  why: string;
  found: boolean;
  version: string | null;
  install: Array<{ label: string; command: string; kind?: 'link' }>;
}

export interface DoctorReport {
  checks: ToolCheck[];
  ready: boolean;
  missingRequired: string[];
  checkedAt: string;
}

export interface CommitLine {
  sha: string;
  subject: string;
}

/** Where a branch tip was parked before Terrarium rewrote it. */
export interface BackupRef {
  ref: string;
  sha: string;
  subject: string;
  at: string;
}

/** The full picture behind a repo's sync chip. */
export interface RepoSyncState {
  repo: string;
  path: string;
  hasOrigin: boolean;
  defaultBranch: string | null;
  branchExists: boolean;
  ahead: number;
  behind: number;
  unrelated: boolean;
  local: CommitLine[];
  remote: CommitLine[];
  checkedOutIn: string | null;
  dirty: boolean;
  /** First 20 dirty paths in `checkedOutIn`, when it exists. */
  dirtyFiles: string[];
  /** Total count behind `dirtyFiles`, which may be truncated. */
  dirtyCount: number;
  backups: BackupRef[];
  sync: RepoSync | null;
}

/** How the dashboard's own clone compares with its origin. */
export interface UpdateStatus {
  state: 'current' | 'ready' | 'blocked' | 'error';
  /** Commits origin has that this copy doesn't. */
  behind: number;
  /** What the update contains, newest first. */
  commits: CommitLine[];
  /** Why nothing can happen automatically — phrased to follow "…, but". */
  reason: string | null;
  checkedAt: string | null;
  applying: boolean;
}

export interface UpdateInfo {
  /** Changes when a fresh server process answers — how a repot is confirmed. */
  bootId: string;
  /** Which copy of Terrarium is running, for the line at the foot of the page. */
  version: AppVersion;
  status: UpdateStatus;
}

export interface AppVersion {
  /** `v1.0.143` — the patch number counts commits, so it moves with every push. */
  label: string;
  /** When that commit was made, ISO, or null outside a git checkout. */
  updatedAt: string | null;
  commit: string | null;
}

export type ResolveAction = 'fetch' | 'rebase' | 'reset';

export interface ResolveResult {
  sync: RepoSync;
  message: string;
  backupRef: string | null;
  state: RepoSyncState;
}

export interface PruneCheck {
  present: boolean;
  /** The folder is on disk *and* git still recognises it as a worktree. */
  usable: boolean;
  dirty: boolean;
  unpushedCount: number;
  branch: string;
  branchExists: boolean;
  repoFound: boolean;
  problem: string | null;
}

/** The plan file in a worktree, and everything the linter reads out of it. */
export interface PlanDoc {
  /** Relative to the worktree, e.g. `docs/plans/add-health-check.md`. */
  file: string | null;
  markdown: string;
  analysis: PlanAnalysis | null;
  /** Where the server looked, so the empty state can name it. */
  dir: string;
}

export interface PlanTask {
  kind: string;
  number: string;
  description: string;
  done: number;
  total: number;
}

export interface PlanProgress {
  checkboxes: { done: number; total: number };
  tasks: { done: number; total: number };
  percent: number;
  complete: boolean;
}

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  line: number;
  message: string;
  hint: string;
}

export interface PlanAnalysis {
  title: string | null;
  overview: string;
  validationCommands: Array<{ command: string; line: number }>;
  tasks: Array<PlanTask & { checkboxes: Array<{ checked: boolean; text: string; line: number }>; line: number }>;
  diagnostics: Diagnostic[];
  progress: PlanProgress;
  valid: boolean;
}

/** What is on a specimen's branch, compared with the branch it was cut from. */
export interface Changes {
  available: boolean;
  reason?: string;
  branch?: string;
  base?: string;
  commits?: Array<{ hash: string; author: string; date: string; subject: string }>;
  commitCount?: number;
  truncatedCommits?: boolean;
  files?: Array<{ status: string; label: string; path: string; added: number | null; removed: number | null }>;
  fileCount?: number;
  totals?: { added: number; removed: number };
  uncommitted?: number;
  /** How much of what is uncommitted is staged — counted, never assumed. */
  staged?: number;
}

/**
 * What opening a merge request would actually do, worked out before anybody
 * presses anything: where it would go, what it would be called, how big it is,
 * and the one sentence for why it cannot happen, when it cannot.
 */
export interface MergeRequestPlan {
  branch: string;
  target: string | null;
  title: string;
  description: string;
  commits: number;
  files: number;
  /** Not committed, so not in the merge request — worth saying out loud. */
  uncommitted: number;
  glab: boolean;
  existing: MergeRequest | null;
  blocked: string | null;
}

/** Everything the tending bench opens on. */
export interface BenchView {
  specimen: SpecimenView;
  plan: PlanDoc;
  /** A run already in flight (or the last one), to reattach to. */
  sessionId: string | null;
  changes: Changes | null;
  sproutEnabled: boolean;
  doctor: DoctorReport;
}

/**
 * Token usage per stage of the loop, and what it cost. The price is worked out
 * from a dated rate table, so it is an estimate at list prices and says so.
 * The flow shows the price alone; the tokens behind it are one click away.
 */
export interface UsageReport {
  live: boolean;
  available: boolean;
  sectioned: boolean;
  caveats: string[];
  totals: {
    input: number;
    output: number;
    cacheCreate: number;
    cacheRead: number;
    total: number;
    cost: number;
    /** Tokens no rate covered — counted, never priced as zero. */
    unpriced: number;
  };
  pricing: { currency: string; estimate: boolean; asOf: string; url: string };
  stages: Array<{ key: string; label: string; kind: string; total: number; cost: number }>;
  models: Array<{ key: string; total: number; cost: number }>;
}

/** The plan on the table, read back out of the interview. */
export interface ProposedPlan {
  title: string | null;
  path: string | null;
  markdown: string;
  progress: PlanProgress;
  tasks: PlanTask[];
  problems: string[];
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/**
 * One thing that happened in a run. `line` is raw output, kept out of the flow
 * as machinery; `stage` is a chapter break the loop printed itself; `ready`
 * says it has produced what it was started for, whatever it does next.
 */
export interface RalphexEvent {
  seq: number;
  type:
    | 'status'
    | 'notice'
    | 'user_text'
    | 'line'
    | 'stage'
    | 'plan'
    | 'review'
    | 'ready'
    | 'question'
    | 'question_closed'
    | 'usage'
    | 'progress'
    | 'session_error'
    | 'done';
  data: Record<string, unknown>;
}

export type SessionStatus =
  | 'starting'
  | 'running'
  | 'asking'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'closed';

class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error ?? `Request failed (${status})`));
    this.status = status;
    this.body = body;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, json);
  return json as T;
}

export const api = {
  terrarium: () => request<TerrariumView>('GET', '/terrarium'),
  /** Fetch origin and fast-forward default branches. `force` skips the throttle. */
  sync: (force: boolean) =>
    request<{ repos: RepoSync[]; skipped: boolean }>('POST', '/sync', { force }),
  syncState: (repo: string) => request<RepoSyncState>('GET', `/repos/${encodeURIComponent(repo)}/sync-state`),
  /** Fetch again, or rewrite the default branch after the human chose how. */
  resolve: (repo: string, action: ResolveAction) =>
    request<ResolveResult>('POST', `/repos/${encodeURIComponent(repo)}/resolve`, { action }),
  /** The last self-update check — cached on the server, no network. */
  updateStatus: () => request<UpdateInfo>('GET', '/update'),
  /** Ask the server to check its own origin right now. */
  updateCheck: () => request<UpdateInfo>('POST', '/update/check'),
  /** Pull, rebuild what changed, restart. The page waits for the new bootId. */
  updateApply: () =>
    request<{ ok: boolean; restarting: boolean; pulled: number; message: string }>('POST', '/update/apply'),
  archive: () => request<{ specimens: SpecimenView[] }>('GET', '/archive'),
  updateSpecimen: (id: string, patch: { checklist?: Checklist; notes?: string; minimized?: boolean }) =>
    request<SpecimenView>('PATCH', `/specimens/${id}`, patch),
  /** The tool checks, re-run now. */
  doctor: () => request<DoctorReport>('GET', '/doctor'),
  /** The plan in this worktree, read fresh off disk. */
  plan: (id: string) => request<PlanDoc>('GET', `/specimens/${id}/plan`),
  /** What the branch carries. */
  changes: (id: string) => request<Changes>('GET', `/specimens/${id}/changes`),
  pruneCheck: (id: string) => request<PruneCheck>('GET', `/specimens/${id}/prune-check`),
  prune: (id: string, opts: { force: boolean }) =>
    request<SpecimenView & { note: string | null }>('POST', `/specimens/${id}/prune`, opts),
  open: (id: string) =>
    request<{ ok: boolean; path?: string; command?: string }>('POST', `/specimens/${id}/open`),
  openPath: (path: string) =>
    request<{ ok: boolean; path?: string; command?: string }>('POST', '/open-path', { path }),
  /** Start the interview. It writes the plan; Terrarium grows the worktree. */
  sproutStart: (repo: string, description: string) =>
    request<{ sessionId: string; sync: RepoSync }>('POST', '/sprout', { repo, description }),
  sproutMessage: (id: string, text: string) => request<{ ok: true }>('POST', `/sprout/${id}/message`, { text }),
  sproutAnswer: (id: string, requestId: string, answers: Record<string, string | string[]>, response?: string) =>
    request<{ ok: true }>('POST', `/sprout/${id}/answer`, { requestId, answers, response }),
  /**
   * Take the plan: stops the interview if it is still going, then grows it.
   * `writing` means the plan was still a draft, and taking it set ralphex
   * writing the file — there is nothing to pot until that lands.
   */
  sproutFinish: (id: string) =>
    request<{ specimens: SpecimenView[]; writing?: boolean }>('POST', `/sprout/${id}/finish`),
  sproutAbort: (id: string) => request<{ ok: true; removed: string[]; failed: string[] }>('POST', `/sprout/${id}/abort`),

  /** The tending bench: the plan, the branch, and any run in flight. */
  bench: (id: string) => request<BenchView>('GET', `/specimens/${id}/bench`),
  /**
   * Set it working through the plan, in this specimen's own worktree. Nothing
   * is sent: growing is the whole loop, and the server decides how it is put
   * together — the models, and how many passes the plan is worth.
   */
  grow: (id: string) => request<{ sessionId: string }>('POST', `/specimens/${id}/grow`),
  benchAnswer: (id: string, requestId: string, answers: Record<string, string | string[]>, response?: string) =>
    request<{ ok: true }>('POST', `/bench/${id}/answer`, { requestId, answers, response }),
  benchMessage: (id: string, text: string) => request<{ ok: true }>('POST', `/bench/${id}/message`, { text }),
  benchStop: (id: string) => request<{ ok: true }>('POST', `/bench/${id}/stop`),
  /** Write what the run came to onto the specimen, so the card remembers it. */
  benchSettle: (id: string) => request<{ specimen: SpecimenView }>('POST', `/bench/${id}/settle`),
  /**
   * Say what is wrong with finished work. The note becomes a short plan of its
   * own — what is already here, then the changes, one step per line — and the
   * loop starts on that rather than on the finished one.
   */
  revise: (id: string, note: string) =>
    request<{ sessionId: string; planPath: string; specimen: SpecimenView }>('POST', `/specimens/${id}/revise`, {
      note,
    }),
  /** What opening a merge request would do, before it is done. */
  mergeRequestCheck: (id: string) => request<MergeRequestPlan>('GET', `/specimens/${id}/merge-request/check`),
  /** Push the branch and open the merge request. The one thing that leaves. */
  mergeRequest: (id: string) =>
    request<{ ok: true; url: string | null; pushed: boolean; specimen: SpecimenView }>(
      'POST',
      `/specimens/${id}/merge-request`,
    ),
};

/** Tokens, in the shorthand a glance wants. */
export function tokens(n: number | null | undefined): string {
  const value = Number(n) || 0;
  if (value < 1000) return String(value);
  if (value < 1e6) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1e6).toFixed(2)}M`;
}

/**
 * A run on the cheapest model costs fractions of a cent, so the small end keeps
 * its digits rather than rounding to a flat $0.00.
 */
export function money(n: number | null | undefined): string {
  const value = Number(n) || 0;
  if (value === 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function age(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 0)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}
