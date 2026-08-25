import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Specimen, StateFile } from './types.ts';

/**
 * Specimen store backed by a single human-readable JSON file (FR-8).
 * Writes are atomic (write-temp-then-rename) so a crash never corrupts it.
 */
export class SpecimenStore {
  #file: string;
  #state: StateFile;

  constructor(file: string) {
    this.#file = file;
    this.#state = this.#load();
    // Fields added after a state file was first written are backfilled in place
    // rather than treated as a schema break — the file stays hand-editable and
    // an older Terrarium can still read it.
    let backfilled = false;
    for (const specimen of this.#state.specimens) {
      if (typeof specimen.minimized !== 'boolean') {
        specimen.minimized = /^tabled[-_. ]/i.test(basename(specimen.worktreePath));
        backfilled = true;
      }
      if (specimen.planPath === undefined) {
        specimen.planPath = null;
        backfilled = true;
      }
      if (specimen.lastRun === undefined) {
        specimen.lastRun = null;
        backfilled = true;
      }
      // A record written before there was a rate table has no price in it, and
      // that reads as unknown rather than as free.
      if (specimen.lastRun && specimen.lastRun.cost === undefined) {
        specimen.lastRun.cost = null;
        backfilled = true;
      }
    }
    if (backfilled) this.save();
  }

  #load(): StateFile {
    let raw: string;
    try {
      raw = readFileSync(this.#file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, specimens: [] };
      }
      throw err;
    }
    let parsed: StateFile;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Never silently discard lifecycle state (FR-2.4): fail loudly and let
      // the developer hand-repair the file with the app closed.
      throw new Error(
        `State file ${this.#file} is not valid JSON. Fix or move it, then restart Terrarium.`,
      );
    }
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.specimens)) {
      throw new Error(`State file ${this.#file} has an unsupported schema.`);
    }
    return parsed;
  }

  save(): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = join(dirname(this.#file), `.state-${process.pid}-${Date.now()}.tmp`);
    writeFileSync(tmp, JSON.stringify(this.#state, null, 2) + '\n', 'utf8');
    renameSync(tmp, this.#file);
  }

  get specimens(): Specimen[] {
    return this.#state.specimens;
  }

  get(id: string): Specimen | undefined {
    return this.#state.specimens.find((s) => s.id === id);
  }

  add(specimen: Specimen): void {
    this.#state.specimens.push(specimen);
    this.save();
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        Specimen,
        | 'checklist'
        | 'notes'
        | 'archivedAt'
        | 'origin'
        | 'worktreePath'
        | 'branch'
        | 'minimized'
        | 'planPath'
        | 'lastRun'
      >
    >,
  ): Specimen {
    const specimen = this.get(id);
    if (!specimen) throw new Error(`Unknown specimen ${id}`);
    Object.assign(specimen, patch);
    this.save();
    return specimen;
  }
}

export function newAvatarSeed(): string {
  return randomBytes(9).toString('base64url');
}

export function newSpecimenId(): string {
  return `sp_${randomBytes(8).toString('hex')}`;
}
