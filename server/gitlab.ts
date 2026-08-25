import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { isAncestor } from './git.ts';
import type { DeployJob, DeploySignal, MergeRequest, Pipeline, RepoInfo, SpecimenView } from './types.ts';

const execFileAsync = promisify(execFile);

/**
 * Merge-request discovery via the `glab` CLI. glab already knows the GitLab
 * host, the project (from the repo's origin remote), and the credentials —
 * reimplementing any of that here would just be a second login to keep alive.
 * No glab, no auth, or no GitLab remote all degrade the same way: no MR chip.
 */

const GLAB_FALLBACKS = ['/opt/homebrew/bin/glab', '/usr/local/bin/glab'];

let cached: string | null | undefined;

/** Locate the `glab` CLI: PATH first, then the usual Homebrew prefixes. */
async function findGlab(): Promise<string | null> {
  if (cached !== undefined) return cached;
  try {
    const { stdout } = await execFileAsync('which', ['glab']);
    cached = stdout.trim() || null;
  } catch {
    cached = GLAB_FALLBACKS.find((p) => existsSync(p)) ?? null;
  }
  return cached;
}

/** The slice of glab's JSON output this module actually reads. */
interface GlabMr {
  iid: number;
  title: string;
  state: string;
  draft: boolean;
  web_url: string;
  /** Where the change landed on the target branch; null until it does. */
  merge_commit_sha: string | null;
  squash_commit_sha: string | null;
}

interface GlabPipeline {
  id: number;
  status: string;
  ref: string;
  updated_at: string;
  web_url: string;
}

interface GlabJob {
  name: string;
  stage: string;
  status: string;
  web_url: string;
  finished_at: string | null;
  environment: { name: string } | null;
}

/** The slice of a GitLab deployment record this module reads. */
interface GlabDeployment {
  sha: string;
  updated_at: string;
  environment: { name: string } | null;
  deployable: { pipeline?: { web_url?: string } } | null;
}

interface CacheEntry {
  mr: MergeRequest | null;
  at: number; // epoch ms of the lookup that produced this
}

/**
 * Knows which merge request each specimen branch has, the same way the
 * Freshener knows each repo's sync state: lookups hit the network during a
 * sync pass and are throttled; `/terrarium` reads the cache synchronously so
 * a slow GitLab never holds up a paint.
 */
export class MrTracker {
  #inflight = new Map<string, Promise<MergeRequest | null>>();
  #cache = new Map<string, CacheEntry>();

  /** The most recent answer for a branch — possibly stale, never blocking. */
  last(repo: string, branch: string): MergeRequest | null {
    return this.#cache.get(key(repo, branch))?.mr ?? null;
  }

  /**
   * Look a branch up on GitLab. Concurrent calls for the same branch share one
   * query; a recent answer (younger than `maxAgeMs`) is reused unless forced.
   * "No MR" is cached too — a branch that never gets one must not cost a
   * network round-trip on every pass.
   */
  lookup(
    repo: string,
    repoPath: string,
    branch: string,
    opts: { force?: boolean; maxAgeMs?: number } = {},
  ): Promise<MergeRequest | null> {
    const k = key(repo, branch);
    const running = this.#inflight.get(k);
    if (running) return running;
    const entry = this.#cache.get(k);
    if (entry && !opts.force && Date.now() - entry.at < (opts.maxAgeMs ?? 0)) {
      return Promise.resolve(entry.mr);
    }
    const pass = this.#query(repoPath, branch)
      .then((mr) => {
        this.#cache.set(k, { mr, at: Date.now() });
        return mr;
      })
      .finally(() => this.#inflight.delete(k));
    this.#inflight.set(k, pass);
    return pass;
  }

  /**
   * `--all` so a merged MR still answers — the specimen whose worktree is gone
   * but whose checklist isn't done is exactly the one whose MR link matters.
   * Among several (branch names get reused), the open one is the current one;
   * failing that the merged one; a closed MR only when it's all there is.
   */
  async #query(repoPath: string, branch: string): Promise<MergeRequest | null> {
    const glab = await findGlab();
    if (!glab) return null;
    try {
      const { stdout } = await execFileAsync(
        glab,
        ['mr', 'list', '--all', `--source-branch=${branch}`, '--per-page=20', '--output', 'json'],
        { cwd: repoPath, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
      );
      const rows = JSON.parse(stdout) as GlabMr[];
      const pick =
        rows.find((r) => r.state === 'opened') ?? rows.find((r) => r.state === 'merged') ?? rows[0];
      if (!pick) return null;
      const state = pick.state === 'opened' || pick.state === 'merged' ? pick.state : 'closed';
      const { pipeline, shipped } = await pipelineFor(glab, repoPath, pick, state);
      return {
        iid: pick.iid,
        title: pick.title,
        state,
        draft: Boolean(pick.draft),
        url: pick.web_url,
        pipeline,
        // Arrival evidence is only meaningful once the change has landed — a
        // deploy job played on an open MR's pipeline is a review app, not QA.
        deployed:
          state === 'merged'
            ? await deploySignals(glab, repoPath, pick.merge_commit_sha ?? pick.squash_commit_sha, shipped)
            : [],
      };
    } catch {
      return null; // unauthenticated, offline, or not a GitLab remote — all mean "no chip"
    }
  }
}

/**
 * The pipeline that matters *now*. While the MR is open that's its own
 * pipeline — the checks standing between the branch and `main`. Once it lands,
 * the interesting pipeline is the one the merge commit started on the target
 * branch: the branch's own checks are history, and the deploy jobs someone has
 * to click through to QA and production live on this one. A merged MR whose
 * commit has no pipeline falls back to the checks, which is better than a gap.
 */
async function pipelineFor(
  glab: string,
  repoPath: string,
  mr: GlabMr,
  state: MergeRequest['state'],
): Promise<{ pipeline: Pipeline | null; shipped: DeploySignal[] }> {
  const landed = mr.merge_commit_sha ?? mr.squash_commit_sha;
  if (state === 'merged' && landed) {
    const commit = await glabApi<{ last_pipeline: GlabPipeline | null }>(
      glab,
      repoPath,
      `projects/:fullpath/repository/commits/${landed}`,
    );
    if (commit?.last_pipeline) return withDeploys(glab, repoPath, commit.last_pipeline, 'deploy');
  }
  // The MR list doesn't carry a pipeline; only the single-MR endpoint does.
  const detail = await glabApi<{ head_pipeline: GlabPipeline | null }>(
    glab,
    repoPath,
    `projects/:fullpath/merge_requests/${mr.iid}`,
  );
  return detail?.head_pipeline
    ? withDeploys(glab, repoPath, detail.head_pipeline, 'checks')
    : { pipeline: null, shipped: [] };
}

/**
 * The pipeline's jobs, read twice over. Jobs sitting on `manual` are the
 * deployments nobody has played yet — a job that has been clicked reports as
 * running or success and drops out, so that list empties itself. Jobs that
 * *succeeded* are the other side of the same coin: a deploy job that ran to
 * green on the pipeline carrying this very change is direct evidence the
 * change reached wherever that job ships to — the kind of evidence that works
 * for pipelines that hand-roll their deploys and declare no environments,
 * this workspace's included. In both cases only the deployments are kept: an
 * optional review or image-build job is an offer, not something anyone is
 * waiting on, and its success ships nothing.
 */
async function withDeploys(
  glab: string,
  repoPath: string,
  raw: GlabPipeline,
  kind: Pipeline['kind'],
): Promise<{ pipeline: Pipeline; shipped: DeploySignal[] }> {
  const jobs = await glabApiList<GlabJob>(glab, repoPath, `projects/:fullpath/pipelines/${raw.id}/jobs`);
  const deploys: DeployJob[] = jobs
    .filter((j) => j.status === 'manual')
    .filter(isDeploy)
    .map((j) => ({ name: j.name, stage: j.stage, url: j.web_url }))
    .sort((a, b) => a.stage.localeCompare(b.stage) || a.name.localeCompare(b.name));
  const shipped: DeploySignal[] = [];
  for (const job of jobs) {
    if (job.status !== 'success' || !isDeploy(job)) continue;
    // A declared environment is the authoritative label — when it exists but
    // doesn't classify (staging, review apps), the job stays unclassified
    // rather than falling back to whatever its name happens to contain.
    const env = classifyEnv(job.environment?.name ?? `${job.stage} ${job.name}`);
    if (env && !shipped.some((s) => s.env === env)) {
      shipped.push({
        env,
        source: 'job',
        name: job.environment?.name ?? job.name,
        url: job.web_url,
        at: job.finished_at ?? raw.updated_at,
      });
    }
  }
  return {
    pipeline: {
      id: raw.id,
      status: raw.status,
      url: raw.web_url,
      kind,
      ref: raw.ref,
      updatedAt: raw.updated_at,
      deploys,
    },
    shipped,
  };
}

/**
 * Where a merged change has demonstrably arrived. The job evidence gathered
 * from its own pipeline comes in already made; GitLab's deployment records
 * fill in the environments that pipeline couldn't speak for — repos that
 * declare environments, and deploys that run on some *other* pipeline, the
 * tag-driven production kind included, since the tag's history carries the
 * merge commit.
 *
 * A deployment record only counts when its commit **contains** the merge,
 * checked against the local clone — a deploy of someone else's change vouches
 * for nothing. And only the newest deployment per environment gets a say: an
 * environment that was rolled back past this change stops claiming it.
 */
async function deploySignals(
  glab: string,
  repoPath: string,
  landed: string | null,
  shipped: DeploySignal[],
): Promise<DeploySignal[]> {
  const byEnv = new Map<DeploySignal['env'], DeploySignal>();
  for (const signal of shipped) byEnv.set(signal.env, signal);
  if (landed) {
    const rows = await glabApiList<GlabDeployment>(
      glab,
      repoPath,
      'projects/:fullpath/deployments?status=success&order_by=created_at&sort=desc',
      1, // the newest hundred — anything older is history, not the current state of an environment
    );
    const settled = new Set(byEnv.keys());
    for (const row of rows) {
      const env = row.environment?.name ? classifyEnv(row.environment.name) : null;
      if (!env || settled.has(env)) continue;
      settled.add(env);
      if (await isAncestor(repoPath, landed, row.sha)) {
        byEnv.set(env, {
          env,
          source: 'environment',
          name: row.environment!.name,
          url: row.deployable?.pipeline?.web_url ?? null,
          at: row.updated_at,
        });
      }
    }
  }
  return [...byEnv.values()].sort((a, b) => a.env.localeCompare(b.env));
}

/**
 * Which checklist box an environment or job name speaks to. Every repo and
 * deploy stack spells these differently — `qa`, `uat`, `deploy:production`,
 * `prod-eu` — so this matches words, not exact names. QA's words are tried
 * first so `pre-prod` lands on QA rather than on the `prod` inside it.
 * Sandbox-ish names (staging, demo, dev, review apps) are deliberately not
 * classified: those environments deploy on merge, and the merge itself is
 * already the sandbox nudge.
 */
const ENV_WORDS: Array<[RegExp, DeploySignal['env']]> = [
  [/\b(qa|uat|acceptance|pre[-_ ]?prod(uction)?)\b/i, 'qa'],
  [/\b(prod(uction)?|live)\b/i, 'production'],
];

function classifyEnv(text: string): DeploySignal['env'] | null {
  for (const [pattern, env] of ENV_WORDS) if (pattern.test(text)) return env;
  return null;
}

/** Stages that exist to ship something, whatever the jobs inside them are called. */
const DEPLOY_STAGE = /^(deploy|post-deploy|qa|prod|release|promote|publish|sandbox|demo)/i;

/**
 * A job that declares an environment has said outright that it deploys. The
 * rest are judged by the stage they sit in, because pipelines that hand-roll
 * their deploys — this workspace's included — often declare no environment at
 * all; a `deploy:`-prefixed name is the last resort.
 */
function isDeploy(job: GlabJob): boolean {
  return (
    Boolean(job.environment?.name) ||
    DEPLOY_STAGE.test(job.stage) ||
    /^deploy[:_-]/i.test(job.name)
  );
}

/** Is `glab` on this machine at all? Everything MR-shaped needs it. */
export async function glabAvailable(): Promise<boolean> {
  return (await findGlab()) !== null;
}

/**
 * Open a merge request for a branch that has just been pushed.
 *
 * Read-only is the rule everywhere else in this module, and this is the one
 * exception — the button that says the work is ready. glab already knows the
 * host, the project and the credentials, so the same argument that made it the
 * way MRs are read makes it the way one is opened.
 *
 * `--yes` is what keeps it non-interactive: without it glab stops on a
 * confirmation nobody can answer through a browser, and the call would hang
 * until the timeout rather than fail. Whatever glab says when it refuses is
 * passed straight back — a merge request that did not open has a reason, and
 * the reason is glab's to give.
 */
export async function createMergeRequest(
  repoPath: string,
  opts: { source: string; target: string; title: string; description: string },
): Promise<{ url: string | null }> {
  const glab = await findGlab();
  if (!glab) throw new Error('glab is not installed, so there is nothing here that can open a merge request.');
  const args = [
    'mr',
    'create',
    '--source-branch',
    opts.source,
    '--target-branch',
    opts.target,
    '--title',
    opts.title,
    '--description',
    opts.description,
    '--yes',
  ];
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync(glab, args, { cwd: repoPath, timeout: 120_000, maxBuffer: 1024 * 1024 }));
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const said = String(e.stderr || e.stdout || e.message || '').trim();
    throw new Error(said || 'glab would not open the merge request and did not say why.');
  }
  // glab prints the URL it made; there is nothing else worth keeping.
  const url = stdout.match(/https?:\/\/\S+/)?.[0] ?? null;
  return { url: url ? url.replace(/[.,)]+$/, '') : null };
}

/**
 * One `glab api` call. `:fullpath` is glab's own placeholder for the repo the
 * command runs in, so the project never has to be configured here either.
 * Anything that isn't the JSON we asked for is the same non-answer as no glab.
 */
async function glabApi<T>(glab: string, repoPath: string, path: string): Promise<T | null> {
  try {
    const { stdout } = await execFileAsync(glab, ['api', path], {
      cwd: repoPath,
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

/**
 * A paged `glab api` list. GitLab caps a page at 100 rows and a monorepo
 * pipeline can be bigger, so read up to `maxPages` pages and stop at the first
 * short one. Anything past the cap is simply not seen — monitoring that runs
 * out of pages degrades to the checkboxes working by hand, like every other
 * failure in this module.
 */
async function glabApiList<T>(
  glab: string,
  repoPath: string,
  path: string,
  maxPages = 3,
): Promise<T[]> {
  const rows: T[] = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let page = 1; page <= maxPages; page++) {
    const batch = await glabApi<T[]>(glab, repoPath, `${path}${sep}per_page=100&page=${page}`);
    if (!batch) break;
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  return rows;
}

/**
 * Refresh MR knowledge for every specimen branch, in parallel. Placeholder
 * branches — `(detached)`, `(unknown)` — aren't names GitLab could know.
 */
export async function refreshMergeRequests(
  tracker: MrTracker,
  repos: RepoInfo[],
  byRepo: Map<string, SpecimenView[]>,
  opts: { force?: boolean; maxAgeMs?: number } = {},
): Promise<void> {
  const lookups: Promise<unknown>[] = [];
  for (const repo of repos) {
    if (repo.error !== null || !repo.path) continue;
    const branches = new Set(
      (byRepo.get(repo.name) ?? []).map((s) => s.branch).filter((b) => b && !b.startsWith('(')),
    );
    for (const branch of branches) lookups.push(tracker.lookup(repo.name, repo.path, branch, opts));
  }
  await Promise.all(lookups);
}

function key(repo: string, branch: string): string {
  return `${repo}\x1f${branch}`;
}
