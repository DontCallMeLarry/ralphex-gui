import { existsSync } from 'node:fs';
import { inspectChanges, type Changes } from './ralphex/changes.ts';
import { findPlan, type PlanDoc } from './ralphex/plans.ts';
import { RalphexSession } from './ralphex/session.ts';
import type { RunMode } from './ralphex/command.ts';
import type { TerrariumConfig } from './config.ts';
import type { Specimen } from './types.ts';

/**
 * How many passes a run gets, read off the plan it is working.
 *
 * ralphex's loop takes one unticked box per pass, so a plan of N steps needs N
 * of them to get through — and a few more for the steps whose validation fails
 * and come round again. Twice the steps is generous for both, and eight at the
 * bottom keeps a two-step plan from being cut off by its own smallness. The
 * ceiling is the point of having one at all: a loop that cannot finish a plan
 * will otherwise keep paying to not finish it.
 */
export function passesFor(steps: number): number {
  return Math.min(60, Math.max(8, steps * 2));
}

/**
 * The tending bench: ralphex, working the plan, inside one specimen's worktree.
 *
 * A card opens onto its plan — the same file the interview wrote — and one
 * button. ralphex does a step, runs the plan's own validation commands, commits
 * and repeats, ticking the plan's checkboxes as it goes. That file is the
 * progress record, so watching the work is re-reading it, which is what the
 * poll below does.
 *
 * One button, and nothing to set on the way past it. Growing is the whole loop
 * every time, and how many passes it gets is read off the plan rather than
 * asked for — the same way the models are: the page sends nothing, and the run
 * is put together here.
 *
 * `--worktree` never appears. The specimen already is one, and ralphex asked to
 * cut another would refuse anyway unless the checkout were on main.
 */
export class TendSession {
  readonly specimenId: string;
  readonly worktreePath: string;
  readonly repoPath: string | null;
  readonly branch: string;
  readonly planPath: string | null;
  /** Which shape of run this was — what gets written onto the specimen after. */
  readonly mode: RunMode = 'execute';
  readonly session: RalphexSession;
  /** What is on the branch, re-read when the run stops. */
  changes: Changes | null = null;
  /** The plan's own progress, as of the last poll. */
  plan: PlanDoc | null = null;
  /**
   * The developer has seen how this run ended. Set when the bench writes the
   * outcome onto the specimen; until then a failed run is still asking to be
   * looked at, which is what the card's red glow says.
   */
  acknowledged = false;

  constructor(config: TerrariumConfig, specimen: Specimen, repoPath: string | null) {
    this.specimenId = specimen.id;
    this.worktreePath = specimen.worktreePath;
    this.repoPath = repoPath;
    this.branch = specimen.branch;
    const found = findPlan(specimen.worktreePath, config.plansDir, specimen.branch, specimen.planPath);
    this.plan = found;
    this.planPath = found.file;

    this.session = new RalphexSession({
      cwd: specimen.worktreePath,
      bin: config.ralphexCommand,
      what: 'grow',
      options: {
        mode: this.mode,
        planPath: found.file ?? '',
        maxIterations: passesFor(found.analysis?.progress.checkboxes.total ?? 0),
        planModel: config.planModel,
        taskModel: config.taskModel,
        reviewModel: config.reviewModel,
      },
      afterExit: () => this.#settle(),
      poll: () => this.#progress(config),
    });
  }

  get id(): string {
    return this.session.id;
  }

  start(): void {
    this.session.start();
  }

  /** ralphex is ticking checkboxes in the plan underneath us; read them back. */
  async #progress(config: TerrariumConfig): Promise<Record<string, unknown> | null> {
    const doc = findPlan(this.worktreePath, config.plansDir, this.branch, this.planPath);
    this.plan = doc;
    if (!doc.analysis) return null;
    return {
      file: doc.file,
      progress: doc.analysis.progress,
      tasks: doc.analysis.tasks.map((task) => ({
        kind: task.kind,
        number: task.number,
        description: task.description,
        done: task.done,
        total: task.total,
      })),
    };
  }

  async #settle(): Promise<void> {
    await this.refreshChanges();
  }

  async refreshChanges(): Promise<Changes> {
    if (!existsSync(this.worktreePath)) {
      this.changes = { available: false, reason: 'This worktree is gone.' };
      return this.changes;
    }
    this.changes = await inspectChanges(this.worktreePath, this.branch, this.repoPath);
    return this.changes;
  }
}

export class TendManager {
  #sessions = new Map<string, TendSession>();
  /** One run at a time per worktree: two would fight over the git index. */
  #bySpecimen = new Map<string, string>();
  #config: TerrariumConfig;

  constructor(config: TerrariumConfig) {
    this.#config = config;
  }

  create(specimen: Specimen, repoPath: string | null): TendSession {
    const running = this.forSpecimen(specimen.id);
    if (running?.session.live) {
      throw new Error('ralphex is already working in this worktree. It commits as it goes, so it runs one at a time.');
    }
    const tend = new TendSession(this.#config, specimen, repoPath);
    this.#sessions.set(tend.id, tend);
    this.#bySpecimen.set(specimen.id, tend.id);
    tend.start();
    return tend;
  }

  get(id: string): TendSession | undefined {
    return this.#sessions.get(id);
  }

  /** The latest session for a specimen, running or not — the bench reopens on it. */
  forSpecimen(specimenId: string): TendSession | undefined {
    const id = this.#bySpecimen.get(specimenId);
    return id ? this.#sessions.get(id) : undefined;
  }

  /** Every live run, so shutdown can stop them rather than orphan them. */
  live(): TendSession[] {
    return [...this.#sessions.values()].filter((tend) => tend.session.live);
  }
}
