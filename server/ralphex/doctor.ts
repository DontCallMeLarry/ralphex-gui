/**
 * What has to be on this machine before anything can grow.
 *
 * A web page cannot install anything, so this does the next most useful thing:
 * it says precisely what is missing and gives a copyable command for each gap.
 * Everything else in the Terrarium keeps working without them — only sprouting
 * and tending need these.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

interface Spec {
  id: string;
  label: string;
  required: boolean;
  why: string;
  probe: (bin: string) => Promise<{ ok: boolean; version: string | null }>;
  install: ToolCheck['install'];
}

const SPECS: Spec[] = [
  {
    id: 'ralphex',
    label: 'ralphex',
    required: true,
    why: 'The loop itself. Sprouting and tending are front ends for this binary.',
    probe: (bin) => probeVersion(bin, ['--version']),
    install: [
      { label: 'Homebrew', command: 'brew install umputun/apps/ralphex' },
      { label: 'From source', command: 'go install github.com/umputun/ralphex@latest' },
      { label: 'Releases', command: 'https://github.com/umputun/ralphex/releases', kind: 'link' },
    ],
  },
  {
    id: 'claude',
    label: 'Claude Code',
    required: true,
    why: 'ralphex drives this to run the interview, execute tasks and review the diff.',
    probe: () => probeVersion('claude', ['--version']),
    install: [
      { label: 'npm', command: 'npm install -g @anthropic-ai/claude-code' },
      { label: 'Log in once', command: 'claude' },
    ],
  },
  {
    id: 'codex',
    label: 'codex',
    required: false,
    why: 'Optional second-vendor review. Missing, ralphex skips the external review pass by itself.',
    probe: () => probeVersion('codex', ['--version']),
    install: [
      { label: 'npm', command: 'npm install -g @openai/codex' },
      { label: 'Or turn it off', command: 'ralphex --external-review-tool=none' },
    ],
  },
];

async function probeVersion(command: string, args: string[]): Promise<{ ok: boolean; version: string | null }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 8_000 });
    return { ok: true, version: firstLine(stdout) || firstLine(stderr) || 'installed' };
  } catch (err) {
    // Some CLIs have no --version but do answer --help.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, version: null };
    try {
      await execFileAsync(command, ['--help'], { timeout: 8_000 });
      return { ok: true, version: 'installed (version unknown)' };
    } catch (helpErr) {
      if ((helpErr as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, version: null };
      // A non-zero exit from --help still means the binary is there.
      return { ok: true, version: 'installed (version unknown)' };
    }
  }
}

function firstLine(text: unknown): string {
  return String(text || '').split('\n')[0].trim();
}

let cache: { at: number; report: DoctorReport } | null = null;
const CACHE_MS = 30_000;

/** Run every check. Cached briefly, since it shells out to three binaries. */
export async function runDoctor(ralphexCommand: string, force = false): Promise<DoctorReport> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.report;

  const checks: ToolCheck[] = await Promise.all(
    SPECS.map(async ({ id, label, required, why, install, probe }): Promise<ToolCheck> => {
      let result: { ok: boolean; version: string | null };
      try {
        result = await probe(id === 'ralphex' ? ralphexCommand : id);
      } catch {
        result = { ok: false, version: null };
      }
      // Claude Code's practical dependency is the login state, not the binary:
      // the agent SDK ships its own copy, so a logged-in machine counts.
      const found =
        id === 'claude'
          ? result.ok || existsSync(join(homedir(), '.claude')) || existsSync(join(homedir(), '.claude.json'))
          : result.ok;
      return { id, label, required, why, install, found, version: result.version };
    }),
  );

  const report: DoctorReport = {
    checks,
    ready: checks.every((c) => !c.required || c.found),
    missingRequired: checks.filter((c) => c.required && !c.found).map((c) => c.label),
    checkedAt: new Date().toISOString(),
  };
  cache = { at: Date.now(), report };
  return report;
}
