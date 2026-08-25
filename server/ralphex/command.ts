/**
 * Turns a run request into an argv for ralphex.
 *
 * Everything here is pure, so the same function can be tested without a child
 * process and the server can reject a bad request before spawning anything.
 * Terrarium never shows the command line it builds: not having to know one is
 * the point.
 *
 * One flag is deliberately absent. ralphex can cut its own worktree with
 * `--worktree`, but every specimen in the Terrarium already *is* a worktree, so
 * ralphex is always run inside one and never asked to make another.
 */

/**
 * The two things Terrarium does with ralphex, and there is no third.
 *
 * ralphex can also work a plan without its reviews, or run the reviews without
 * working the plan. Neither is on the glass and neither ever was worth being:
 * a screen with a dropdown on it asks the developer to hold an opinion about a
 * loop they came here not to think about. Growing is the whole loop, every
 * time.
 */
export type RunMode = 'plan' | 'execute';

export interface RunModeSpec {
  id: RunMode;
  label: string;
  flags: string[];
  requiresPlan: boolean;
}

export const RUN_MODES: Record<RunMode, RunModeSpec> = {
  plan: {
    id: 'plan',
    // The interview: ralphex reads the codebase, asks its clarifying questions
    // and writes the plan file. Its picker falls back to numbered prompts on a
    // plain pipe, which is what makes it answerable from the browser.
    label: 'Interview',
    flags: [],
    requiresPlan: false,
  },
  execute: {
    id: 'execute',
    // The loop: a task, the plan's own validation commands, a commit, again —
    // and then the review passes over what it left.
    label: 'Grow it',
    flags: [],
    requiresPlan: true,
  },
};

const DURATION = /^\d+(ms|s|m|h)$/;
const MODEL = /^[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+)?$/;
// Anything that would need a shell to mean what it looks like. Terrarium spawns
// without a shell, so these would be passed through literally.
const SHELL_META = /[;&|<>$`\\!*?()"']/;

export interface RunOptions {
  bin?: string;
  mode?: RunMode | string;
  planPath?: string;
  planDescription?: string;
  maxIterations?: number | string | null;
  maxExternalIterations?: number | string | null;
  reviewPatience?: number | string | null;
  sessionTimeout?: string;
  idleTimeout?: string;
  wait?: string;
  baseRef?: string;
  planModel?: string;
  taskModel?: string;
  reviewModel?: string;
  externalReviewTool?: string;
  skipFinalize?: boolean;
  passClaudeMd?: boolean;
  preserveAnthropicApiKey?: boolean;
  debug?: boolean;
  color?: boolean;
}

export interface BuiltCommand {
  bin: string;
  args: string[];
  display: string;
  mode: string;
  launchable: boolean;
  errors: string[];
}

function pushIf(args: string[], condition: unknown, ...items: string[]): void {
  if (condition) args.push(...items);
}

/** POSIX-ish quoting, used only when a command has to be written down. */
export function quoteArg(arg: unknown): string {
  const s = String(arg);
  if (s === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function formatCommand(bin: string, args: string[]): string {
  return [bin, ...args].map(quoteArg).join(' ');
}

/** Build the ralphex invocation. */
export function buildCommand(options: RunOptions = {}): BuiltCommand {
  const {
    bin = 'ralphex',
    mode = 'execute',
    planPath = '',
    planDescription = '',
    maxIterations = null,
    maxExternalIterations = null,
    reviewPatience = null,
    sessionTimeout = '',
    idleTimeout = '',
    wait = '',
    baseRef = '',
    planModel = '',
    taskModel = '',
    reviewModel = '',
    externalReviewTool = '',
    skipFinalize = false,
    passClaudeMd = false,
    preserveAnthropicApiKey = false,
    debug = false,
    color = false,
  } = options;

  const errors: string[] = [];
  const spec = RUN_MODES[mode as RunMode];

  if (!spec) {
    return {
      bin,
      args: [],
      display: bin,
      mode: String(mode),
      launchable: false,
      errors: [`Unknown run mode "${mode}".`],
    };
  }

  const args = [...spec.flags];

  if (mode === 'plan') {
    const description = String(planDescription).trim();
    if (!description) errors.push('Say what you want built.');
    else args.push('--plan', description);
  }

  if (maxIterations !== null && maxIterations !== '' && maxIterations !== undefined) {
    const n = Number(maxIterations);
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      errors.push('Stop after must be a whole number between 1 and 500.');
    } else {
      args.push(`--max-iterations=${n}`);
    }
  }

  for (const [value, flag, label] of [
    [maxExternalIterations, '--max-external-iterations', 'Max external iterations'],
    [reviewPatience, '--review-patience', 'Review patience'],
  ] as const) {
    if (value === null || value === '' || value === undefined) continue;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 500) errors.push(`${label} must be a whole number between 0 and 500.`);
    else if (n > 0) args.push(`${flag}=${n}`);
  }

  for (const [value, flag, label] of [
    [sessionTimeout, '--session-timeout', 'Session timeout'],
    [idleTimeout, '--idle-timeout', 'Idle timeout'],
    [wait, '--wait', 'Rate-limit wait'],
  ] as const) {
    const v = String(value || '').trim();
    if (!v) continue;
    if (!DURATION.test(v)) errors.push(`${label} must look like 30s, 45m or 2h (got "${v}").`);
    else args.push(`${flag}=${v}`);
  }

  for (const [value, flag, label] of [
    [planModel, '--plan-model', 'Plan model'],
    [taskModel, '--task-model', 'Task model'],
    [reviewModel, '--review-model', 'Review model'],
  ] as const) {
    const v = String(value || '').trim();
    if (!v) continue;
    if (!MODEL.test(v)) errors.push(`${label} must look like "haiku" or "sonnet:low" (got "${v}").`);
    else args.push(`${flag}=${v}`);
  }

  const tool = String(externalReviewTool || '').trim();
  if (tool) {
    if (!['codex', 'custom', 'none'].includes(tool)) {
      errors.push('External review tool must be codex, custom or none.');
    } else {
      args.push(`--external-review-tool=${tool}`);
    }
  }

  const ref = String(baseRef || '').trim();
  if (ref) {
    if (/\s/.test(ref) || SHELL_META.test(ref)) errors.push(`"${ref}" is not a valid git ref.`);
    else args.push(`--base-ref=${ref}`);
  }

  pushIf(args, skipFinalize, '--skip-finalize');
  pushIf(args, passClaudeMd, '--pass-claude-md');
  pushIf(args, preserveAnthropicApiKey, '--preserve-anthropic-api-key');
  pushIf(args, debug, '--debug');
  // Terrarium parses the stream to place lines and read questions out of it;
  // ANSI escapes only get in the way.
  pushIf(args, !color, '--no-color');

  const plan = String(planPath || '').trim();
  if (mode !== 'plan') {
    if (plan) {
      if (!plan.endsWith('.md')) errors.push('Plan path must be a .md file.');
      else if (plan.startsWith('-')) errors.push('Plan path cannot start with "-".');
      else args.push(plan);
    } else if (spec.requiresPlan) {
      errors.push(`"${spec.label}" needs a plan file, and this specimen has none.`);
    }
  }

  return {
    bin,
    args,
    display: formatCommand(bin, args),
    mode: String(mode),
    launchable: errors.length === 0,
    errors,
  };
}
