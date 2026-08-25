import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const execFileAsync = promisify(execFile);

const MAC_APP_CODE = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';

let cached: string | null | undefined;

/** Locate the `code` CLI: config override, PATH, then the macOS app bundle. */
export async function findCodeCli(configured: string | null): Promise<string | null> {
  if (configured) return existsSync(configured) ? configured : null;
  if (cached !== undefined) return cached;
  try {
    const { stdout } = await execFileAsync('which', ['code']);
    cached = stdout.trim() || null;
  } catch {
    cached = existsSync(MAC_APP_CODE) ? MAC_APP_CODE : null;
  }
  return cached;
}

/**
 * FR-5: open a worktree in VS Code. When the CLI is unavailable, return the
 * copyable command instead of failing silently.
 */
export async function openInVsCode(
  worktreePath: string,
  configured: string | null,
): Promise<{ ok: true } | { ok: false; path: string; command: string }> {
  const cli = await findCodeCli(configured);
  if (!cli) {
    return { ok: false, path: worktreePath, command: `code ${shellQuote(worktreePath)}` };
  }
  const child = spawn(cli, [worktreePath], { detached: true, stdio: 'ignore' });
  child.unref();
  return { ok: true };
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}
