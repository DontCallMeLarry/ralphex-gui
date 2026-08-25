/**
 * What a run spent, assembled from whatever sources can see it.
 *
 * The meter owns two things a source deliberately does not: where the run
 * actually ran, and what has already been read. Sources stay dumb readers.
 *
 * Nothing here touches the session beyond the lines it already recorded. A run
 * is a start, an end and a list of lines, and that is all the measurement
 * needs — which is what keeps this addable and removable without the loop
 * noticing.
 */
import { buildTimeline, stageAt, type Stage, type TimelineEvent } from './stages.ts';
import { groupTotals, totalsFor, type Totals, type UsageSample } from './model.ts';
import { PRICING_URL, RATES_AS_OF, priceSamples, unpricedModels } from './pricing.ts';
import { createClaudeCodeSource, type UsageSource } from './claude-code.ts';

const SAMPLE_CAP = 50_000;

/** Totals with a price on them. `unpriced` is tokens no rate covered. */
export interface PricedTotals extends Totals {
  cost: number;
  unpriced: number;
}

export interface StageUsage extends PricedTotals {
  key: string;
  label: string;
  kind: string;
  phase: string;
  index: number | null;
  from: number;
  to: number | null;
  lines: number;
}

export interface UsageReport {
  live: boolean;
  available: boolean;
  collectedAt: string;
  /** Whether ralphex's own "--- stage ---" headers were found. */
  sectioned: boolean;
  sessions: number;
  sources: Array<{ id: string; label: string; available: boolean; dir: string | null; reason: string | null }>;
  caveats: string[];
  totals: PricedTotals;
  /** What the price is and is not: list prices, on the date they were read. */
  pricing: { currency: 'USD'; estimate: true; asOf: string; url: string };
  stages: StageUsage[];
  models: Array<PricedTotals & { key: string }>;
  agents: Array<PricedTotals & { key: string }>;
}

export class UsageMeter {
  #dirs: string[];
  #sources: UsageSource[];
  #samples: UsageSample[] = [];
  #seen = new Set<string>();
  #cursors: Record<string, Record<string, number>> = {};
  #truncated = false;

  /**
   * @param dirs every directory this run's agent might have worked in
   * @param sources defaults to Claude Code's own transcripts
   */
  constructor(dirs: string[], sources: UsageSource[] | null = null) {
    this.#dirs = dirs;
    this.#sources = sources ?? [createClaudeCodeSource()];
  }

  /** Read whatever has been written since the last call and total it all up. */
  read(
    events: TimelineEvent[],
    run: { startedAt: string; endedAt: string | null; live: boolean },
  ): UsageReport {
    const { stages, sectioned } = buildTimeline(events, run);
    const from = new Date(run.startedAt).getTime();
    const to = run.endedAt ? new Date(run.endedAt).getTime() : null;

    const sources: UsageReport['sources'] = [];
    for (const source of this.#sources) {
      const described = source.describe();
      const entry = {
        id: source.id,
        label: source.label,
        available: described.available,
        dir: described.dir || null,
        reason: described.reason || null,
      };
      sources.push(entry);
      if (!described.available) continue;

      try {
        const result = source.collect({ dirs: this.#dirs, from, to, cursor: this.#cursors[source.id] || {} });
        this.#cursors[source.id] = result.cursor || {};
        for (const sample of result.samples) {
          if (this.#seen.has(sample.key)) continue;
          if (this.#samples.length >= SAMPLE_CAP) {
            this.#truncated = true;
            break;
          }
          this.#seen.add(sample.key);
          this.#samples.push(sample);
        }
      } catch (err) {
        entry.reason = `Could not read usage: ${(err as Error).message}`;
        entry.available = false;
      }
    }

    return this.#assemble(stages, sectioned, run.live, sources);
  }

  #assemble(stages: Stage[], sectioned: boolean, live: boolean, sources: UsageReport['sources']): UsageReport {
    const samples = this.#samples;
    // Every totals record in the report carries its own price, worked out from
    // the model each turn ran on.
    const priced = (group: UsageSample[]) => ({ ...totalsFor(group), ...priceSamples(group) });
    const byStage = new Map<string, UsageSample[]>(stages.map((stage) => [stage.key, []]));
    for (const sample of samples) {
      const stage = stageAt(stages, sample.ts);
      if (stage) byStage.get(stage.key)!.push(sample);
    }

    const sessions = new Set<string>();
    for (const sample of samples) if (sample.sessionId) sessions.add(sample.sessionId);

    const caveats: string[] = [];
    if (samples.length && !sectioned) {
      caveats.push(
        'ralphex printed no "--- stage ---" headers in this run, so the stages here are Terrarium\'s own ' +
          'reading of the output — coarser, and a misread line moves tokens between stages.',
      );
    }
    if (this.#truncated) {
      caveats.push(`More than ${SAMPLE_CAP} model turns; the totals stop there.`);
    }
    const unpricedOn = unpricedModels(samples);
    if (unpricedOn.length) {
      caveats.push(
        `No published rate for ${unpricedOn.join(', ')}, so those tokens are counted but not priced. ` +
          'The rate table is in server/ralphex/usage/pricing.ts.',
      );
    }

    return {
      live,
      available: samples.length > 0,
      collectedAt: new Date().toISOString(),
      sectioned,
      sessions: sessions.size,
      sources,
      caveats,
      totals: priced(samples),
      pricing: { currency: 'USD', estimate: true, asOf: RATES_AS_OF, url: PRICING_URL },
      stages: stages.map((stage) => ({
        key: stage.key,
        label: stage.label,
        kind: String(stage.kind),
        phase: stage.phase,
        index: stage.index,
        from: stage.from,
        to: stage.to,
        lines: stage.lines,
        ...priced(byStage.get(stage.key) || []),
      })),
      models: groupTotals(samples, (sample) => sample.model || 'unknown', priceSamples) as UsageReport['models'],
      agents: groupTotals(samples, (sample) => sample.agent, priceSamples) as UsageReport['agents'],
    };
  }
}
