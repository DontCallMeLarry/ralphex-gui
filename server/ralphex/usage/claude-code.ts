/**
 * Token usage from Claude Code's own session transcripts.
 *
 * ralphex runs `claude --output-format stream-json --verbose --print` once per
 * stage, parses that stream for text, and throws the rest away — the usage
 * block never reaches ralphex's stdout. But Claude Code independently writes
 * every turn to a transcript of its own:
 *
 *   $CLAUDE_CONFIG_DIR/projects/<cwd with non-alphanumerics replaced by ->/
 *     <session-id>.jsonl
 *
 * and each `"type":"assistant"` record in it carries message.usage, the model,
 * the working directory, an ISO timestamp, and isSidechain (true for the review
 * subagents). That is the whole measurement, already on disk, written whether
 * or not Terrarium is watching.
 *
 * So this source reads. It starts nothing, sets no environment variable, and
 * changes nothing about how ralphex is invoked — which is the only way to add
 * measurement to a loop that is already running without perturbing it.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { toTokens, type UsageSample } from './model.ts';

// The window is deliberately asymmetric. Terrarium stamps the start before it
// spawns anything and shares a clock with the agent, so no turn of this run can
// predate it — the near edge gets no grace at all. The far edge does: a turn
// still in flight when ralphex exits is written a moment after. Grace on the
// near edge would instead annex the previous run's last turns in a worktree
// that is reused, which is the failure worth avoiding.
const END_GRACE_MS = 15_000;

// Claude Code's own project-directory slug: every non-alphanumeric byte becomes
// a dash. Longer than this and it appends a hash we do not reproduce, which is
// what the directory scan below is for.
const SLUG_LIMIT = 200;

// A file's mtime and Date.now() do not come from the same clock, and on some
// filesystems the first is coarser by a whole second. The mtime check below is
// only there to skip transcripts that obviously predate the run, so it gets
// that much slack; the per-record timestamp is the filter that actually
// decides what belongs to this run.
const MTIME_SLACK_MS = 2_000;

export function slugFor(dir: string): string {
  return String(dir).replace(/[^a-zA-Z0-9]/g, '-');
}

/** Where Claude Code keeps transcripts, honouring its own env var. */
export function projectsRoot(): string {
  if (process.env.TERRARIUM_CLAUDE_PROJECTS_DIR) return process.env.TERRARIUM_CLAUDE_PROJECTS_DIR;
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(configDir, 'projects');
}

function statOrNull(target: string) {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

/**
 * Transcript directories that could hold this run's sessions.
 *
 * The fast path is the slug of each candidate checkout. The scan is the
 * fallback for a path long enough to be hashed, or a checkout Terrarium guessed
 * wrong — records are filtered by their own `cwd` afterwards either way, so a
 * wider net costs time, never accuracy.
 */
function candidateDirs(root: string, dirs: string[], from: number): string[] {
  const found: string[] = [];
  let missing = false;
  for (const dir of dirs) {
    const slug = slugFor(dir);
    const target = join(root, slug);
    if (slug.length > SLUG_LIMIT) {
      missing = true;
      continue;
    }
    if (statOrNull(target)?.isDirectory()) found.push(target);
    else missing = true;
  }
  if (!missing) return found;

  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const target = join(root, entry.name);
    if (found.includes(target)) continue;
    const stat = statOrNull(target);
    if (stat && stat.mtimeMs >= from - MTIME_SLACK_MS) found.push(target);
  }
  return found;
}

/** Read from `offset` to EOF, returning whole lines and the new offset. */
function readFrom(file: string, offset: number, size: number): { lines: string[]; offset: number } {
  if (size <= offset) return { lines: [], offset };
  let handle: number;
  try {
    handle = openSync(file, 'r');
  } catch {
    return { lines: [], offset };
  }
  try {
    const length = size - offset;
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(handle, buffer, 0, length, offset);
    const text = buffer.toString('utf8', 0, read);
    const cut = text.lastIndexOf('\n');
    // A transcript is appended to while we read it. Stop at the last newline
    // and leave the partial tail for the next poll rather than parsing half a
    // record and dropping it.
    if (cut === -1) return { lines: [], offset };
    return {
      lines: text.slice(0, cut).split('\n').filter(Boolean),
      offset: offset + Buffer.byteLength(text.slice(0, cut + 1), 'utf8'),
    };
  } finally {
    closeSync(handle);
  }
}

interface TranscriptRecord {
  type?: string;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  requestId?: string;
  uuid?: string;
  isSidechain?: boolean;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens_details?: { thinking_tokens?: number };
    };
  };
}

/**
 * One transcript record to a UsageSample, or null when it is not a metered
 * model turn belonging to this run.
 */
export function sampleFrom(
  record: TranscriptRecord | null,
  { dirs, from, to }: { dirs: string[]; from: number; to: number | null },
): UsageSample | null {
  if (!record || record.type !== 'assistant') return null;
  const message = record.message;
  const usage = message?.usage;
  if (!usage) return null;
  // Claude Code writes a placeholder assistant turn for an API error; it
  // carries a usage block of zeroes and a synthetic model name.
  if (message?.model === '<synthetic>') return null;

  const ts = Date.parse(String(record.timestamp));
  if (!Number.isFinite(ts)) return null;
  if (ts < from) return null;
  if (to !== null && ts > to + END_GRACE_MS) return null;
  if (dirs.length && record.cwd && !dirs.includes(record.cwd)) return null;

  const key = `${record.requestId || ''}:${message?.id || record.uuid || ts}`;
  return {
    source: 'claude-code',
    key,
    ts,
    model: message?.model || null,
    sessionId: record.sessionId || null,
    agent: record.isSidechain ? 'subagent' : 'main',
    tokens: toTokens({
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheCreate: usage.cache_creation_input_tokens,
      cacheRead: usage.cache_read_input_tokens,
      reasoning: usage.output_tokens_details?.thinking_tokens,
    }),
  };
}

export interface UsageSource {
  id: string;
  label: string;
  describe(): { available: boolean; dir: string; reason: string | null };
  collect(query: { dirs: string[]; from: number; to: number | null; cursor: Record<string, number> }): {
    samples: UsageSample[];
    cursor: Record<string, number>;
  };
}

/** `root` overrides the transcript directory, for tests and odd installs. */
export function createClaudeCodeSource({ root }: { root?: string } = {}): UsageSource {
  const rootFor = () => root || projectsRoot();

  return {
    id: 'claude-code',
    label: 'Claude Code',

    describe() {
      const dir = rootFor();
      const stat = statOrNull(dir);
      if (!stat || !stat.isDirectory()) {
        return {
          available: false,
          dir,
          reason: `No Claude Code transcripts at ${dir}. Set CLAUDE_CONFIG_DIR if Claude Code keeps its state elsewhere.`,
        };
      }
      return { available: true, dir, reason: null };
    },

    collect({ dirs = [], from, to = null, cursor = {} }) {
      const state = { ...cursor };
      const dir = rootFor();
      if (!statOrNull(dir)?.isDirectory()) return { samples: [], cursor: state };

      const samples: UsageSample[] = [];
      for (const projectDir of candidateDirs(dir, dirs, from)) {
        let files: string[] = [];
        try {
          files = readdirSync(projectDir);
        } catch {
          continue;
        }
        for (const name of files) {
          if (!name.endsWith('.jsonl')) continue;
          const file = join(projectDir, name);
          const stat = statOrNull(file);
          if (!stat || !stat.isFile()) continue;
          // A transcript untouched since before the run started cannot hold
          // any of it.
          if (stat.mtimeMs < from - MTIME_SLACK_MS) continue;

          let offset = state[file] || 0;
          if (stat.size < offset) offset = 0; // truncated or replaced
          const { lines, offset: next } = readFrom(file, offset, stat.size);
          state[file] = next;

          for (const line of lines) {
            let record: TranscriptRecord;
            try {
              record = JSON.parse(line);
            } catch {
              continue;
            }
            const sample = sampleFrom(record, { dirs, from, to });
            if (sample) samples.push(sample);
          }
        }
      }
      return { samples, cursor: state };
    },
  };
}
