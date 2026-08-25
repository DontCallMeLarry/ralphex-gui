import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TerrariumConfig {
  /** Absolute path to the parent folder that gets scanned for repos. */
  parentDir: string;
  /** Repo directory names excluded from discovery (the dashboard's own repo lives here). */
  excludeRepos: string[];
  /** Worktrees whose path contains any of these substrings are ignored (tool-internal worktrees). */
  excludeWorktreePatterns: string[];
  /** Localhost port. 7855 is 0x1EAF, which reads as LEAF. */
  port: number;
  /**
   * Fetch origin and fast-forward each repo's default branch on startup and on
   * load, so new worktrees always come off current code. Set false to work
   * offline; the Refresh button still syncs on demand.
   */
  autoSync: boolean;
  /** How long a fetch stays fresh enough to skip on an automatic pass. */
  autoSyncMinutes: number;
  /**
   * How often the dashboard checks its own origin for updates, in hours.
   * 0 disables the automatic check; Refresh still checks on demand. Auto
   * checks also stop when `autoSync` is false — that flag means no network.
   */
  updateCheckHours: number;
  /** Absolute path to the JSON state file. */
  stateFile: string;
  /**
   * Whether Sprout may start a ralphex interview, and the tending bench a run.
   * Turning it off leaves the rest of the Terrarium working, which is what it
   * is for: everything else here only reads.
   */
  sproutEnabled: boolean;
  /** The ralphex binary to drive. */
  ralphexCommand: string;
  /** Where a repo keeps its plan files — ralphex writes one here per interview. */
  plansDir: string;
  /**
   * The model every stage runs on. Terrarium's page has no control for this and
   * never sends one: whatever is left blank is filled in from here, so the
   * interview is as cheap as the run.
   */
  planModel: string;
  taskModel: string;
  reviewModel: string;
  /** Optional override for the VS Code CLI binary. */
  codeCommand: string | null;
  /** Absolute path to the app root (repo of the dashboard itself). */
  appRoot: string;
}

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  parentDir: '..',
  excludeRepos: ['dev-dashboard'],
  // Tool-internal worktrees and scratch checkouts in temp dirs: real to git,
  // but not work anyone is shepherding to production. `.ralphex/worktrees/` is
  // ralphex's own scratch checkout, which it makes and removes by itself.
  excludeWorktreePatterns: ['/.claude/worktrees/', '/.ralphex/worktrees/', '/tmp/'],
  port: 7855,
  autoSync: true,
  autoSyncMinutes: 2,
  updateCheckHours: 6,
  stateFile: 'data/state.json',
  sproutEnabled: true,
  ralphexCommand: 'ralphex',
  plansDir: 'docs/plans',
  planModel: 'haiku',
  taskModel: 'haiku',
  reviewModel: 'haiku',
  codeCommand: null as string | null,
};

export function loadConfig(): TerrariumConfig {
  // TERRARIUM_CONFIG points at an alternate config file, so a second terrarium
  // (or a test run against a scratch folder) never disturbs the real one.
  const configPath = process.env.TERRARIUM_CONFIG
    ? resolve(process.env.TERRARIUM_CONFIG)
    : resolve(APP_ROOT, 'terrarium.config.json');
  let raw: Partial<typeof DEFAULTS> = {};
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Failed to read ${configPath}: ${(err as Error).message}`);
    }
    // No config file: sensible defaults apply on first run.
  }
  const merged = { ...DEFAULTS, ...raw };
  // Relative paths resolve against the config file's own directory (for the
  // default config that is the app root, so nothing changes there).
  const base = dirname(configPath);
  return {
    parentDir: resolve(base, merged.parentDir),
    excludeRepos: merged.excludeRepos,
    excludeWorktreePatterns: merged.excludeWorktreePatterns,
    port: merged.port,
    autoSync: merged.autoSync,
    autoSyncMinutes: merged.autoSyncMinutes,
    updateCheckHours: merged.updateCheckHours,
    stateFile: resolve(base, merged.stateFile),
    sproutEnabled: merged.sproutEnabled,
    ralphexCommand: merged.ralphexCommand,
    plansDir: merged.plansDir,
    planModel: merged.planModel,
    taskModel: merged.taskModel,
    reviewModel: merged.reviewModel,
    codeCommand: merged.codeCommand,
    appRoot: APP_ROOT,
  };
}
