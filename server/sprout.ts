import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  addWorktreeOnNewBranch,
  branchExists,
  commitPaths,
  changedFiles,
  deleteBranch,
  getDefaultBranch,
  isTracked,
  pruneRegistrations,
  removeWorktree,
} from './git.ts';
import { branchNameForPlan, parsePlan, slugify } from './ralphex/plan.ts';
import { listPlanFiles } from './ralphex/plans.ts';
import { RalphexSession } from './ralphex/session.ts';
import type { TerrariumConfig } from './config.ts';

/**
 * Sprout: the interview, and the worktree it earns.
 *
 * The developer describes the work and `ralphex --plan` takes over — it reads
 * the repo, asks its clarifying questions, and writes the plan file, title and
 * all. Terrarium relays the conversation and does exactly one thing at the end
 * of it: it grows the seedling. The plan's filename is the branch name, so the
 * worktree goes in beside its siblings under `worktrees/<repo>/`, cut from
 * current code, with the plan committed onto it as its first commit.
 *
 * The plan file is the finish line, not the process leaving. Once the file is
 * on disk the interview has done its job, and it is free to carry on offering
 * to work the plan there and then — potting stops it and grows the seedling
 * regardless. Waiting for it to exit is what used to leave the developer stuck
 * in a conversation with no way out of it.
 *
 * Writing that file is the one part of the interview ralphex hands to a model,
 * and a model can leave without doing it — ralphex then finds no plan of its
 * own, says so, and exits cleanly. The plan is not lost when that happens: the
 * markdown was on the screen the developer took it from, so Terrarium writes
 * it into the plans directory itself and the seedling grows as usual.
 *
 * ralphex shows the plan as a draft before it writes anything, and asks what to
 * do with it. Terrarium answers that itself: sprouting takes the draft, which
 * is what makes ralphex write the file, and typing what is wrong with it sends
 * it back for another pass. Neither is ever put to the developer as a picker —
 * two of its four answers (open an editor, throw it away) mean nothing here.
 *
 * Nothing about the change is decided here. Titles and branch names are the
 * interview's to choose, and a plan Terrarium wrote itself would be a second,
 * quieter design nobody agreed to.
 */

/** How often the plans directory is checked for the file the interview writes. */
const PLAN_WATCH_MS = 1_500;
/** How long a stopped interview gets to leave before the seedling is grown anyway. */
const STOP_GRACE_MS = 10_000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

export interface SproutOutcome {
  worktreePath: string;
  branch: string;
  /** The plan, relative to the worktree. */
  planPath: string;
}

export class SproutSession {
  readonly repo: string;
  readonly repoPath: string;
  /** What the interview grew, once it has. Empty until then. */
  outcome: SproutOutcome | null = null;

  readonly session: RalphexSession;
  #config: TerrariumConfig;
  #plansBefore = new Set<string>();
  #watch: NodeJS.Timeout | null = null;
  #growing: Promise<void> | null = null;

  constructor(config: TerrariumConfig, repo: string, repoPath: string, description: string) {
    this.#config = config;
    this.repo = repo;
    this.repoPath = repoPath;
    this.#plansBefore = new Set(listPlanFiles(repoPath, config.plansDir));

    this.session = new RalphexSession({
      cwd: repoPath,
      bin: config.ralphexCommand,
      what: 'interview',
      plansDir: config.plansDir,
      planCacheDir: join(dirname(config.stateFile), 'plans'),
      options: {
        mode: 'plan',
        planDescription: description,
        // Every stage runs on the cheapest model there is, and nothing in the
        // page can pick one: an interview should cost no more than it has to.
        planModel: config.planModel,
        taskModel: config.taskModel,
        reviewModel: config.reviewModel,
      },
      afterExit: () => this.#grow(),
    });
  }

  get id(): string {
    return this.session.id;
  }

  start(): void {
    this.session.start();
    // The plan file is what makes a seedling pottable, and it can land long
    // before the process does. Nothing else notices it appearing.
    this.#watch = setInterval(() => this.#lookForPlan(), PLAN_WATCH_MS);
    this.#watch.unref?.();
  }

  /** Written its plan yet? Once it has, potting works whatever it does next. */
  get ready(): boolean {
    return this.outcome !== null || this.session.isReady;
  }

  #lookForPlan(): void {
    if (this.session.isReady) {
      if (this.#watch) clearInterval(this.#watch);
      this.#watch = null;
      return;
    }
    const found = this.#planInPlansDir();
    if (!found) return;
    this.session.signalReady({ planPath: relative(this.repoPath, found).split(sep).join('/') });
  }

  /** The one new plan file in the plans directory, if the interview wrote one. */
  #planInPlansDir(): string | null {
    const fresh = listPlanFiles(this.repoPath, this.#config.plansDir).filter((file) => !this.#plansBefore.has(file));
    return fresh.length ? fresh[fresh.length - 1] : null;
  }

  /**
   * The one way on, whatever stage the plan is at.
   *
   * ralphex shows the plan as a draft first and writes the file only once it
   * is taken, so taking it is the whole of approving it — there is no second
   * button that only agrees. When the plan is still a draft this accepts it
   * and comes back with nothing: the file is a model pass away, and the caller
   * comes again when it lands. When the file is there, this pots the seedling.
   */
  async take(): Promise<SproutOutcome | null> {
    if (this.outcome) return this.outcome;
    if (!this.session.isReady && !(await this.#newPlan()) && this.session.acceptDraft()) return null;
    return this.pot();
  }

  /** Is the plan written, or drafted and waiting to be taken? */
  get hasPlan(): boolean {
    return this.ready || this.session.isReviewingDraft;
  }

  /**
   * Keep the seedling, now.
   *
   * The interview is stopped rather than waited on: it has written the plan,
   * and whatever it wants to do next belongs in the worktree the plan is about,
   * not in the checkout it was started from.
   */
  async pot(): Promise<SproutOutcome> {
    if (!this.outcome && this.session.live) {
      // Nothing is stopped for a seedling that does not exist yet: an interview
      // still working on its plan is left to finish working on it.
      if (!(await this.#newPlan())) {
        throw new Error('The interview has not written a plan yet, so there is nothing to pot.');
      }
      this.session.note('Potting — winding the interview up.');
      this.session.cancel();
      await Promise.race([this.session.whenExited(), delay(STOP_GRACE_MS)]);
    }
    await this.#grow();
    if (this.#watch) clearInterval(this.#watch);
    this.#watch = null;
    return this.outcome!;
  }

  /**
   * The interview is over and there is a plan on disk. Turn it into a seedling:
   * a branch named after the plan, a worktree beside its siblings, and the plan
   * itself as the branch's first commit.
   */
  #grow(): Promise<void> {
    // The process leaving and the developer potting can land together; either
    // way exactly one worktree gets cut.
    this.#growing ??= this.#growOnce().finally(() => {
      this.#growing = null;
    });
    return this.#growing;
  }

  async #growOnce(): Promise<void> {
    if (this.outcome) return;
    const plan = (await this.#newPlan()) ?? this.#writeTakenPlan();
    if (!plan) {
      throw new Error(
        'The interview ended without writing a plan, so there is nothing to grow. ' +
          'Read what it said above, then try again with more to go on.',
      );
    }

    const planRelative = relative(this.repoPath, plan).split(sep).join('/');
    const branch = await this.#freeBranch(branchNameForPlan(planRelative));
    const worktreesDir = join(this.#config.parentDir, 'worktrees', this.repo);
    mkdirSync(worktreesDir, { recursive: true });
    const worktreePath = join(worktreesDir, branch);
    if (existsSync(worktreePath)) {
      throw new Error(`${worktreePath} already exists, so the seedling has nowhere to go.`);
    }

    const base = await this.#startPoint();
    await addWorktreeOnNewBranch(this.repoPath, worktreePath, branch, base);

    // The plan is an untracked file in the main checkout. It belongs on the
    // branch, where ralphex will tick its boxes — so it moves rather than
    // being copied, and the developer's own checkout is left as it was found.
    const inTree = join(worktreePath, planRelative);
    mkdirSync(dirname(inTree), { recursive: true });
    copyFileSync(plan, inTree);
    await commitPaths(worktreePath, [planRelative], `Add plan: ${basename(planRelative, '.md')}`);
    if (!(await isTracked(this.repoPath, planRelative))) {
      rmSync(plan, { force: true });
    } else {
      this.session.note(
        `${planRelative} was already tracked in ${this.repo}, so the copy there was left alone.`,
        'warn',
      );
    }

    this.outcome = { worktreePath, branch, planPath: planRelative };
    // The seedling exists, whether the interview or this wrote the plan out —
    // and the page is waiting on exactly that to finish potting.
    this.session.signalReady({ planPath: planRelative });
    this.session.note(`Seedling ready: ${branch}, cut from ${base}.`);
  }

  /**
   * The plan the developer took, written out because ralphex did not.
   *
   * Taking the draft is what sets ralphex writing the file, and the writing is
   * a model's job — one that sometimes ends without it. What was on the plan
   * screen at that moment is the document that was approved, so it is written
   * under the interview's own naming and everything downstream carries on as
   * if the interview had written it. Nothing is invented here: a draft nobody
   * took leaves this alone, and so does an interview that never showed one.
   */
  #writeTakenPlan(): string | null {
    const markdown = this.session.takenPlan;
    if (!markdown.trim()) return null;

    const dir = resolve(this.repoPath, this.#config.plansDir);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const slug = slugify(parsePlan(markdown).title ?? '');
    let file = join(dir, `${stamp}-${slug}.md`);
    for (let n = 2; existsSync(file); n += 1) file = join(dir, `${stamp}-${slug}-${n}.md`);

    mkdirSync(dir, { recursive: true });
    writeFileSync(file, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
    this.session.note(
      `It left without writing the plan out, so the plan you took was written to ${relative(this.repoPath, file).split(sep).join('/')}.`,
      'warn',
    );
    return file;
  }

  /**
   * The plan file the interview just wrote. The plans directory is where
   * ralphex puts one, so that is where we look first; a repo that keeps them
   * somewhere else still gets found, because an interview leaves exactly one
   * new markdown file behind and git knows which.
   */
  async #newPlan(): Promise<string | null> {
    const inPlansDir = this.#planInPlansDir();
    if (inPlansDir) return inPlansDir;

    try {
      const changed = (await changedFiles(this.repoPath))
        .filter((path) => path.toLowerCase().endsWith('.md'))
        .map((path) => join(this.repoPath, path))
        .filter((path) => existsSync(path) && !this.#plansBefore.has(path));
      if (changed.length === 1) return changed[0];
      // More than one is not an answer: guessing which is the plan would put
      // the wrong file on the branch and name the branch after it.
      if (changed.length > 1) {
        this.session.note(
          `${changed.length} markdown files changed during the interview, so which one is the plan is not clear.`,
          'warn',
        );
      }
    } catch {
      /* a repo we cannot ask is the same as one with nothing to say */
    }
    return null;
  }

  /** A branch name nothing already holds. */
  async #freeBranch(wanted: string): Promise<string> {
    const base = slugify(wanted);
    let name = base;
    for (let n = 2; n < 100; n += 1) {
      if (!(await branchExists(this.repoPath, name))) return name;
      name = `${base}-${n}`;
    }
    throw new Error(`Too many branches called ${base}.`);
  }

  /**
   * What the worktree is cut from. Terrarium fetched origin the moment before
   * this session started, so `origin/<default>` is current; a repo with no
   * remote falls back to its own default branch.
   */
  async #startPoint(): Promise<string> {
    const name = await getDefaultBranch(this.repoPath);
    if (name) return `origin/${name}`;
    for (const candidate of ['main', 'master']) {
      if (await branchExists(this.repoPath, candidate)) return candidate;
    }
    throw new Error(`${this.repo} has no default branch to cut a worktree from.`);
  }

  /**
   * Abandoning composts the seedling: the worktree and its branch go, and so
   * does the plan, which only ever existed to describe them. A failure to
   * remove something is reported, never thrown.
   */
  async compost(): Promise<{ removed: string[]; failed: string[] }> {
    if (this.#watch) clearInterval(this.#watch);
    this.#watch = null;
    this.session.close();
    const removed: string[] = [];
    const failed: string[] = [];
    const grown = this.outcome;
    if (!grown) return { removed, failed };
    this.outcome = null;

    try {
      if (existsSync(grown.worktreePath)) await removeWorktree(this.repoPath, grown.worktreePath, true);
      else await pruneRegistrations(this.repoPath);
      removed.push(grown.worktreePath);
    } catch (err) {
      failed.push(`${grown.worktreePath}: ${(err as Error).message}`);
    }
    try {
      if (await branchExists(this.repoPath, grown.branch)) await deleteBranch(this.repoPath, grown.branch);
    } catch (err) {
      failed.push(`${grown.branch}: ${(err as Error).message}`);
    }
    return { removed, failed };
  }
}

export class SproutManager {
  #sessions = new Map<string, SproutSession>();
  #config: TerrariumConfig;

  constructor(config: TerrariumConfig) {
    this.#config = config;
  }

  create(repo: string, repoPath: string, description: string): SproutSession {
    const sprout = new SproutSession(this.#config, repo, repoPath, description);
    this.#sessions.set(sprout.id, sprout);
    sprout.start();
    return sprout;
  }

  get(id: string): SproutSession | undefined {
    return this.#sessions.get(id);
  }
}
