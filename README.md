# 🪴 Terrarium

A local dashboard for git worktrees, with [ralphex](https://github.com/umputun/ralphex)
doing the work in them. It scans the repos sitting next to it in one parent folder and
shows every worktree across all of them. Each one carries three checkboxes: verified in
sandbox, QA, and production. It replaces the piece of paper that tracked what shipped
where.

Two things happen through ralphex, the extended Ralph loop that drives Claude Code through
a plan task by task, running your tests after each one and committing as it goes:

- **Sprout** starts ralphex's interview, as four screens one after the other: say what you
  want built, answer what it asks, read the plan, meet the specimen. It reads the repo, asks
  its clarifying questions, and writes the plan itself — including the title, which becomes
  the branch name. The plan arrives as a draft, and the plan screen has two ways on and no
  third: say what is wrong with it and it goes back for another pass, or sprout it. Sprouting
  is the approval — taking the draft is what makes ralphex write the file — and then Terrarium
  grows the worktree beside its siblings, cut from current code, with the plan committed onto
  it as the first commit. The interview never leaves on its own: it offers to work the plan in
  the checkout it was started from, which is the one place it must not, so sprouting is what
  winds one up.
- **Clicking a specimen** opens the tending bench: its plan, and one button. ralphex does a
  step, runs the plan's own validation commands, commits, and repeats — inside that
  worktree and no other. The plan's checkboxes tick as each step lands, because that file
  is ralphex's progress record as well as its brief. There is nothing to set on the way
  past the button: growing is the whole loop every time, and how many passes it may make
  is read off the plan — twice its steps, never fewer than eight or more than sixty, which
  is room for every step and the ones that come round again, and still a stop.

No command line is ever shown, and neither is the tool's name: not having to know either is
the point. A question is drawn as the question and its choices; a failure is a sentence; the
plan is a markdown document with a button that opens it. Everything ralphex printed lives
behind one **technical details** toggle — including the progress log's stamped copy of every
line it already said, and the `QUESTION:`/`OPTIONS:` protocol wrapped around a picker, which
is the same thing said two and three times over.

Watching it work is watching it work, not reading a log of it. While a run is going the
screen holds the plan's own ticking checkboxes and one line saying what it is up to: the
phase named outright — **BUILDING**, **REVIEWING**, **FINISHING** — then the same thing said
the terrarium's way, then whatever ralphex's own stage boundary carried after its colon.
*REVIEWING · going over it leaf by leaf — critical/major · 40s.* Every box can be ticked and
the loop still going, and that line is how you know why. The loop's count of its passes is a
small ticker at the end of it, where a number that only goes up belongs, and the elapsed time
is read off the transcript rather than the screen — closing the bench and opening it again
does not restart the clock on a run that never stopped.

And a card that has something happening in it says so without being read: a green glow
behind it, breathing, while ralphex works; a steady blue while it is stopped and waiting on
an answer; a steady red when it stopped badly and nobody has looked yet. Opening the bench
is the looking, and that is what clears the red. Cards only — a modal is already the only
thing you are looking at.

A card is one thing about one piece of work, so all of it opens the bench: anywhere that is
not already a button, a checkbox, a link out or the notes box. The name and the branch are
just text. The one other thing to press is the plant itself, which opens what this worktree
is *for* — the plan's own Overview, which is otherwise a document behind a button behind the
bench.

The plan is never scrollback. Whatever ralphex does — print the markdown, or write the file
and name it — Terrarium ends up with a file, writing one under `data/plans/` when only the
text came back, and the plan screen reads it. Approving a plan you cannot see is the one
thing this must never ask for, so the tasks are always showing and the whole document is one
button away.

Nor is a plan lost by being taken. Writing the file is the one part of the interview ralphex
hands to a model, and a model can end its turn without doing it — ralphex then finds no plan,
says how long it took, and exits cleanly. What was on the plan screen when the developer took
it is the document they approved, so Terrarium writes it into the plans directory itself,
under ralphex's own `YYYYMMDD-slug.md` naming, and the seedling grows on it as usual.

That date stays in the plans folder, where it keeps the files in order, and goes no further:
the branch and the worktree beside it are called `donut-background`, not
`20260824-donut-background`. Eight digits on the front of a folder name are eight digits
between you and what the work is.

What ralphex asks about a draft — Accept, Revise, Interactive review, Reject — never reaches
the glass either. Two of those cannot happen through a browser at all (one opens `$EDITOR`,
one throws the plan away), and the other two are the plan screen's own two buttons, so
Terrarium answers that picker itself. A plan is only linted for what ralphex actually trips
over: its own prompt writes a bare `# Title` and no `## Validation Commands` section, so
neither of those is missing from a plan Terrarium grew.

## Run it

```sh
npm install
npm run build     # once, and after frontend changes
npm start         # boots the server and opens the browser
```

The lockfile is not tracked: npm rewrites it differently from one version to the next, so a
tracked one is dirty the moment you install and the next `git pull` refuses to move. `npm
install` is the whole install. The foot of the page says which copy you are running —
`v1.0.143 · 24 Aug 2026`, where the last number counts commits, so it moves with every push.

It comes up on <http://localhost:7855> — 0x1EAF, which reads as LEAF. Stop with Ctrl-C; any
run in flight is stopped with it. Growing needs `ralphex` and `claude` on the machine;
without them the button says what to install and everything else still works. The
`sproutEnabled` key switches growing off entirely, for a copy you only want to read with.
To run with no terminal window (macOS, optional):

```sh
npm run agent:install     # starts now and at every login
npm run agent:status
npm run agent:uninstall
```

## How it works

- The filesystem decides which worktrees exist. The state file (data/state.json, per-machine,
  gitignored) holds the checkboxes, notes and each specimen's plan; deleting a worktree by
  hand keeps its record, since post-merge testing outlives the worktree.
- Checkboxes are manual: GitLab evidence (a merged MR, a matching deploy) makes the
  plant ask for the tick in a speech bubble. It never ticks one itself.
- Each repo's default branch stays level with origin via a strict fast-forward. Sprouting
  fetches first, unthrottled, so a new worktree always comes off current code. A diverged
  branch gets a warning chip that opens a dialog to rebase or reset, always onto a backup
  ref first.
- ralphex is always run inside a specimen's worktree, never asked to cut one of its own:
  `--worktree` is a flag Terrarium does not build. One run at a time per worktree, because
  two would fight over the git index.
- Stopping a run sends SIGINT, then SIGTERM at 8s, then SIGKILL at 20s, against the whole
  process group — so the `claude` processes ralphex spawned go too.
- Potting keeps the seedling as a specimen; abandoning composts the worktree, the branch
  and the plan instead. Prune does the same for a potted one, then archives the record.
- Every dialog closes on Escape or an outside click; closing never triggers its action. The
  bench will not close out from under a running loop.
- The MR chip comes from glab; without it the chip is missing, opening a merge request says
  so, and everything else works.
- A finished specimen offers three things, in the order they happen: read it in the editor,
  say what is wrong with it, send it off. The middle one writes a short plan of its own —
  a summary of what is already built, then the note, one step per line — and runs the loop
  on that, so a small change costs a small context rather than the whole original design.

Git writes are limited to the fast-forward, the worktree and plan commit a sprout ends
with, the plan commit a change note adds, staging a specimen's own worktree, a
worktree-and-branch removal at two moments — prune, and composting an abandoned sprout —
and one push. ralphex commits to the branch and stops. The push is the only thing here
that leaves the machine, and it happens on one button, behind a dialog that says which
branch is going where, what the merge request will be called, and what in the worktree is
not committed and so is not in it. Until somebody presses it, GitLab is only read: you
read the diff and decide.

Staging is the one that happens constantly, and on purpose. Whatever a run leaves
uncommitted is `git add -A`'d when the run stops, whenever the bench reads what landed,
and again before Open in VS Code — so the editor opens on a change rather than on a
folder with something different in it somewhere. Reviewing means reading a diff, and
reading a diff happens in an editor, never on this page: what the bench says about a
finished run is how big it is and where it is waiting, because a list of the files a run
touched is not a review and cannot be turned into one by reading it. Staging commits
nothing, obeys .gitignore, and `git reset` puts it back.

## What it spends

ralphex does not report tokens. It runs Claude Code with `--output-format stream-json`,
reads that stream for text, and drops the `result` event carrying the usage payload. But
Claude Code writes every turn to a session transcript of its own, so Terrarium reads those
instead, and attributes each turn to whichever stage was open when it happened — cutting on
the `--- task iteration 3 ---` section headers ralphex prints between stages. Those same
headers are what the status line and its ticker are read out of.

Nothing is injected to make that work: no wrapper on `claude`, no environment variable, no
extra flag. It reads a file that is already being written, which is why it cannot perturb a
run.

The flow carries the price alone — small, at the top, as `est. $0.0042`. A token count is
not something anyone can feel, and across two models it does not add up to one number
either; clicking the price opens the breakdown, per model and per stage, which is where the
tokens behind it are. The price is worked out here, from the dated rate table in
`server/ralphex/usage/pricing.ts` — the real cost lives in the `result` event ralphex drops,
so this is an estimate at Anthropic's list prices and says so. A model the table has no rate
for is counted but not priced, rather than quietly costing nothing.
`docs/token-usage.md` is the full standard, including how to add another agent.

Every stage runs on the cheapest model, and the page has no control that changes it:
whatever a request leaves blank is filled in from `terrarium.config.json` before anything is
spawned, so the interview is as cheap as the run.

## Updates

Terrarium updates through git: every 6 hours it fetches its own origin. When origin is
ahead, a banner offers to repot — fast-forward, rebuild what changed, restart — nothing
applies without a click. A copy with local commits or changes is left alone, and says why.

## Configuration

terrarium.config.json, all keys optional:

| Key | Default | Meaning |
|---|---|---|
| parentDir | `".."` | Folder scanned for repositories |
| excludeRepos | `["dev-dashboard"]` | Repo folders to skip |
| excludeWorktreePatterns | `["/.claude/worktrees/", "/.ralphex/worktrees/", "/tmp/"]` | Ignore worktrees whose path contains these |
| port | `7855` | Localhost port (0x1EAF, which reads as LEAF) |
| autoSync | `true` | Sync with origin on startup and load; `false` = no network at all |
| autoSyncMinutes | `2` | How long a fetch counts as fresh |
| updateCheckHours | `6` | Self-update check cadence; `0` turns it off |
| stateFile | `"data/state.json"` | Where lifecycle records live |
| sproutEnabled | `true` | Whether ralphex may be started at all; off, Sprout and the bench do nothing |
| ralphexCommand | `"ralphex"` | The ralphex binary to drive |
| plansDir | `"docs/plans"` | Where a repo keeps its plan files |
| planModel / taskModel / reviewModel | `"haiku"` | The model each stage runs on |
| codeCommand | `null` | VS Code CLI path; auto-detected |

The TERRARIUM_CONFIG env var points at an alternate config file, so a second terrarium never disturbs the first.

## Development

```sh
npm test              # 151 tests, no network, no ralphex needed
npm run typecheck
npm run dev:server    # server with --watch
npm run dev:web       # Vite on :5173, proxying /api
```

| | |
|---|---|
| `server/ralphex/plan.ts` | plan parser and linter (pure) |
| `server/ralphex/command.ts` | run options to argv (pure) |
| `server/ralphex/phases.ts` | output line classification (pure) |
| `server/ralphex/readout.ts` | transcript to question, and to why a run stopped (pure) |
| `server/ralphex/plans.ts` | finding a worktree's plan on disk, with path containment |
| `server/ralphex/session.ts` | spawning, streaming, questions, cancellation |
| `server/ralphex/usage/` | token usage: record shape, pricing, stage attribution, source adapters |
| `server/ralphex/changes.ts` | what a run committed to the branch |
| `server/ralphex/doctor.ts` | what has to be installed |
| `server/sprout.ts` | the interview, and the worktree it earns |
| `server/tend.ts` | ralphex working the plan in one worktree |
| `web/src/components/Transcript.tsx` | the shared view of a ralphex session |
| `web/src/components/TendDialog.tsx` | the bench a card opens onto |

`test/fixtures/fake-ralphex.mjs` stands in for the real binary — pointed at through the
`ralphexCommand` config key, so nothing in the product carries a test seam. It follows the
real interview line for line, down to the prompts that end without a newline and the draft
review picker, because every one of those is something Terrarium has to read. There is no
demo mode in the app.
