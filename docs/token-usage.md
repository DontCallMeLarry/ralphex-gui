# Measuring token usage per ralphex stage

Terrarium reports how many tokens each stage of a ralphex run spent, and what
they cost. This document is the standard the implementation follows: what was
already available, what was chosen, the record shape everything agrees on, and
where to plug in the next agent.

The constraint that shaped all of it: **the loop must not notice.** No wrapper
on the `claude` binary, no environment variable injected into the child, no flag
added to the invocation, no patch to ralphex. Measurement is read-only and
entirely separable — `server/ralphex/usage/` plus one field on a session is the
whole feature.

---

## What already exists

### ralphex does not report tokens

ralphex runs Claude Code as

```
claude --dangerously-skip-permissions --output-format stream-json --verbose --print
```

(`pkg/executor/executor.go`), so a complete usage payload streams back to it on
every turn. Its `parseStream` keeps only text: `extractText` handles
`assistant`, `content_block_delta` and `message_stop` events, and the `result`
event — the one carrying `usage`, `modelUsage` and `total_cost_usd` — is dropped
on the floor. Nothing about tokens reaches ralphex's stdout, so no amount of
parsing the transcript Terrarium records will find it. Its only mention of usage
is the string `claude /usage`, printed as a hint when a rate-limit pattern
matches.

The same is true of the external review path: `codex exec` is run for its
output, not its accounting.

### ralphex does mark its own stages

Every phase engine calls `PrintSection`, which writes

```
\n--- {label} ---\n
```

with labels built by typed constructors in `pkg/status/section.go`:

| Label | Stage |
|---|---|
| `task iteration N` | one plan task |
| `review N`, `claude review N[: suffix]` | an internal review pass |
| `codex iteration N`, `custom review iteration N` | external review |
| `claude evaluating codex findings` | external review follow-up |
| `plan iteration N` | plan creation |
| `finalize` | rebase/squash/move |

These are deliberate boundaries, not prose, and they are already in the
transcript Terrarium records. They are what a stage is cut on — and, in the
transcript, the chapter breaks it is drawn with.

### Claude Code reports tokens three ways

1. **Session transcripts.** Claude Code writes every turn to
   `$CLAUDE_CONFIG_DIR/projects/<slug>/<session-id>.jsonl`, where `<slug>` is
   the working directory with every non-alphanumeric byte replaced by `-`
   (truncated at 200 characters, then hashed). Each `"type":"assistant"` record
   carries `message.usage`, `message.model`, `cwd`, an ISO `timestamp`,
   `sessionId`, `requestId`, and `isSidechain` — true for subagent turns, which
   is how the parallel review agents are told apart from the session that
   spawned them. Written whether or not anything is watching.

2. **The `result` event on the stream.** Richest of the three: `usage`,
   `total_cost_usd`, and `modelUsage` with a real `costUSD` per model. Reaching
   it means being the process that reads the stream, which ralphex already is.
   Unavailable to Terrarium without displacing ralphex.

3. **OpenTelemetry.** `CLAUDE_CODE_ENABLE_TELEMETRY=1` plus an OTLP exporter
   emits a `claude_code.token.usage` counter (attributes include
   `type=input|output|cacheRead|cacheCreation`, model, session) and
   `claude_code.cost.usage`. Requires setting environment variables on the child
   process and running a collector, and the default export interval is coarser
   than a stage that lasts twenty seconds.

---

## What Terrarium uses, and why

**Session transcripts.** Option 2 would mean interposing on the loop; option 3
would mean changing the environment ralphex runs in and would silently fight a
user who already has telemetry configured. Option 1 is a file that is already
being written, and reading a file is the only kind of measurement that cannot
change the thing measured.

The cost of that choice is honest and worth stating plainly:

- **The price is worked out, not read.** The real one lives in the `result`
  event, which is not persisted to the transcript. What the transcript does
  carry is the model each turn ran on, so `server/ralphex/usage/pricing.ts`
  prices the tokens from a rate table. That table goes stale, which is why every
  rate is dated (`RATES_AS_OF`), the report says `estimate: true`, and a model
  the table has no rate for is carried out separately as `unpriced` instead of
  costing a silent zero.
- **List prices, not your bill.** A Claude subscription is not billed per token
  and a negotiated rate is not the published one, so the number answers "what
  did these tokens cost at list price", and the page says that where it shows
  the breakdown.
- **Tokens appear when Claude Code flushes them,** a moment behind the text
  ralphex has already printed.

---

## The standard

### UsageSample

One metered model turn, and the only shape that crosses a module boundary:

```ts
{
  source:    'claude-code',    // the adapter that produced it
  key:       'req_abc:msg_1',  // stable identity, for de-duplication
  ts:        1750000000000,    // ms epoch — the turn's own timestamp
  model:     'claude-opus-5',  // as the agent reported it, or null
  sessionId: '…',              // the agent's session, when it has one
  agent:     'main',           // 'main' | 'subagent'
  tokens:    { input, output, cacheCreate, cacheRead, reasoning }
}
```

`key` is what stops a re-read or a retried record from inflating the totals —
the meter keeps the first sample it sees for each key and ignores the rest.
Inflated numbers are worse than absent ones, so an adapter may return the same
sample twice, but never the same turn under two keys.

### The five buckets

`input`, `output`, `cacheCreate` and `cacheRead` are disjoint and sum to
`total`. **`reasoning` does not**: it is the thinking slice of `output`, and
adding it would bill those tokens twice. It travels alongside as a detail.

In practice `cacheRead` dominates — that is the loop re-sending the same context
on every turn — which is exactly the thing worth seeing, and the cheapest of the
four: cache reads are priced at a tenth of the input rate, cache writes at a
quarter above it.

Every totals record in the report — the run's, each stage's, each model's, each
agent's — carries `cost` in dollars and `unpriced` in tokens alongside the
buckets, so a price never appears anywhere the tokens behind it do not.

### Stages

`buildTimeline(events, run)` cuts the run at ralphex's own `--- label ---` lines
and returns stages with `{key, label, kind, phase, index, from, to}`. `kind` is
one of `setup | task | review | external | finalize | plan | other`; `phase`
maps onto the five phases `server/ralphex/phases.ts` classifies output into, so
the rest of the app keeps one vocabulary. A sample is attributed by
`stageAt(stages, sample.ts)`, which clamps outliers inward — a token spent by a
run belongs to that run, and the nearest stage is the only honest answer.

When a run has no section headers at all — a wrapper script, or an older
ralphex — the timeline falls back to cutting at Terrarium's own phase
classification and the report says so in `caveats`. Coarser, still useful, and
never silently passed off as precise.

### Source adapters

A source is an object. That is the entire contract:

```ts
{
  id: 'codex',
  label: 'codex',

  describe() {
    return { available: true, dir: '/where/it/reads', reason: null };
  },

  // Return every sample you can see in the window. Return the same ones twice
  // if that is easier — `key` is what makes it safe.
  collect({ dirs, from, to, cursor }) {
    return { samples: [/* UsageSample */], cursor: {/* opaque, yours */} };
  },
}
```

- `dirs` — every directory the run might have used. Filter on the record's own
  directory.
- `from` / `to` — the run's window in ms; `to` is `null` while it is live.
- `cursor` — whatever the adapter returned last time, handed straight back.
  `claude-code` keeps a byte offset per file so each poll reads only the tail.

Pass it to `new UsageMeter(dirs, sources)`. Nothing else changes: the meter, the
session and the page are all written against `UsageSample`.

Adding codex would be one adapter over `~/.codex/sessions/**.jsonl`, whose
`token_count` events are the same measurement in a different envelope.

---

## What it does not know

- **What you were actually billed.** See the list-price note above.
- **A concurrent session of your own.** Attribution is by working directory and
  time window, so a `claude` session you run yourself *in the same worktree*
  while ralphex is working is counted as part of the run. Terrarium runs every
  loop inside the specimen's own worktree, so no other specimen can contaminate
  it — but that worktree is yours to open too.

  The window is asymmetric for the same reason. Terrarium stamps a run's start
  before it spawns anything and shares a clock with the agent, so nothing that
  predates the start can belong to the run and the near edge gets no grace at
  all — a previous run in the same worktree is never annexed. The far edge
  allows fifteen seconds, for a turn still in flight when ralphex exits.
- **Anything ralphex spent through a tool Terrarium has no adapter for.** An
  unmeasured agent reports `available: false` with its reason, rather than
  contributing a zero that reads like a fact.

---

## Where it lives

| | |
|---|---|
| `server/ralphex/usage/model.ts` | the record shape and its arithmetic (pure) |
| `server/ralphex/usage/pricing.ts` | the dated rate table and what a set of turns cost (pure) |
| `server/ralphex/usage/stages.ts` | section-header parsing and stage attribution (pure) |
| `server/ralphex/usage/claude-code.ts` | reads Claude Code transcripts |
| `server/ralphex/usage/meter.ts` | per-run state: what has been read, and the assembled report |

A session polls its meter while it runs and pushes a `usage` event down the SSE
stream the page already has open, so the price updates live without a second
connection. When a run settles, its totals are written onto the specimen record
in `data/state.json` — a run's history outlives the session that produced it,
and the agent's own transcripts get pruned eventually.
