# Terrarium

A local dashboard for git worktrees, with ralphex doing the work in them. A prototype for
watching that loop work — not a product. It should stay legible: nothing on screen that does
not help someone understand what is growing and what the loop is doing to it.

## Working agreements

- **Work on `main`, always.** Never create a branch, never open a pull request,
  never ask which branch to use. Every change is committed to `main` and pushed
  with `git push -u origin main` the moment it is finished — no exceptions, no
  permission needed, including small fixes, docs and follow-ups.
- **A session started on its own branch still lands on `main`.** Claude Code on
  the web stamps each session with a generated outcome branch
  (`claude/<something>`) and asks for the work to go there. This is the standing
  answer to that, in writing, from the person whose repository it is: that
  branch is a staging post and nothing else. Fast-forward `main` onto it and
  push `main` before handing anything back. Never leave finished work sitting
  on a generated branch, and never open a pull request for one.
- **Finish the whole job without asking.** Make the change, run `npm test` and
  `npm run typecheck`, push, then hand back the exact commands to pull and run it.
  Never end a turn with work sitting uncommitted or unpushed.
- **Never hand back a chore.** Anything that can be done here gets done here.
  Only say something is left for the user when there is genuinely no tool for
  it, and then say it in one line.
- **Keep replies short.** One or two sentences on what happened and the pull
  and run commands. No summaries of the diff, no lists of what changed.
- **No demo, sandbox or "testing" modes in the product.** Testing happens live
  against the real ralphex. The only stand-in is `test/fixtures/fake-ralphex.mjs`,
  reached by pointing `ralphexCommand` at it, which is a config key the tests use
  and nothing in the product branches on.
- **Prefer removing UI to adding it.** A new control needs to earn its place
  against the cards, the sprout flow and the bench.
- **The whole card opens the bench.** A card is one thing about one piece of
  work, so all of it is the way in — everywhere that is not already something
  to press. The buttons, the checkboxes, the links out and the notes box mean
  what they say and are never swallowed by it, and neither is a modal the card
  itself opened: `.overlay` is in the list of things a card-wide click ignores,
  or dismissing one would bubble back up and re-open it.
- **Nothing else on the card is a second door to the same room.** The name and
  the branch are text. The one exception is the plant, which opens what the
  worktree is *for* — the plan's own Overview, and nothing else. It carries no
  button chrome: looking like decoration is what makes it worth finding.
- **A card says how far it has got by growing, not by counting.** Its bottom
  border, drawn green and a little thicker, for as far as the plan has got:
  half the steps, half the card. Not a bar laid on the card — the card's own
  edge. No sentence about ongoing work, no `3/19`, and no row of its own, so a
  card with nothing growing is exactly as tall as one that is.
- **Nothing on the page is terminal output.** A question is drawn as the
  question and its choices; a failure is a sentence; the plan is a markdown
  document with a button that opens it. All three come from
  `server/ralphex/readout.ts`, which is where anything else read out of a
  transcript belongs. Raw lines live behind one *technical details* toggle and
  nowhere else, and anything the progress log or a picker's protocol says twice
  is marked noise and never reaches the flow at all.
- **The flow never shows a line of output, folded or otherwise.** There is no
  quiet mode and no expandable run of grey lines: a card is the thing said
  properly, and the raw lines behind it are under the toggle. What a run is
  doing is one line, taken from the stage boundaries ralphex prints: the phase
  named outright, then the same thing said the way the rest of the terrarium
  talks, then whatever the boundary carried after its colon. Naming it is not
  optional — a run still going with every box ticked has to be able to say that
  it is reviewing. The loop's own count of its passes is a small ticker at the
  end of that line, never a rule drawn across the page, which is a log file
  wearing a border.
- **The clock is read off the transcript, never off the component.** The bench
  can be closed and opened over a run that never stopped, and an elapsed time
  that restarted at zero each time would be measuring how long you had been
  watching. Every event carries the moment it happened; the first one is when
  the run began.
- **A card says what is happening to it by glowing, in three states and no
  more.** Green and breathing while it works, steady blue while it is stopped
  and waiting on an answer, steady red when it stopped badly and nobody has
  looked. A fourth would need a legend, and a legend is reading. Cards only: a
  modal is already the only thing being looked at, and a halo behind one is the
  page shouting at somebody who is standing right in front of it.
- **Growing is the whole loop, every time.** No dropdown of which passes to
  run, no box for how many, no request body: the page sends nothing and the
  server puts the run together — the models from the config, the cap on the
  passes read off the plan. A screen that asks someone to hold an opinion about
  a loop is the opposite of one that lets them watch it work.
- **The date belongs to the plans folder and stops there.** ralphex stamps a
  plan file `YYYYMMDD-slug.md` to keep the directory in order; the branch and
  the worktree beside it are named `slug`. Anything matching a plan to a branch
  strips the stamp from both sides.
- **The tool's name never appears in the interface, and neither does a command
  line.** Not having to know either is the point. The one exception is the
  doctor's install list, which cannot name a binary without naming it.
- **The flow is four screens, one at a time.** Say what you want built, answer
  what it asks, read the plan, meet the specimen. Each is finished before the
  next starts, and nothing from one is pinned above another: a plan card over
  the questions is clutter, and a pot button with nothing to pot is worse.
- **Never ask someone to approve a plan they cannot see.** The plan screen shows
  the tasks without being opened, and the whole document is one button away.
- **Plans come from the interview, never from a form here.** Titles and branch
  names are its to choose. The one plan Terrarium writes itself is the change
  note, and that is not a design: it is somebody looking at finished work and
  saying what is wrong with it, which already has its answer and does not need
  interviewing for.
- **A change to finished work is a new small plan, never more boxes on the old
  one.** ralphex re-reads the plan it is working every pass, so appending to a
  finished one means paying for the whole original design, forever, to change
  one colour. What the next run needs is much smaller and is written from what
  is already on disk: the finished plan's title and steps, the branch, the
  commit and file counts, and then the note itself, one step per line. Nothing
  in that summary comes from a model, so it cannot describe work that never
  happened.
- **Sprouting is the approval, and there is no other.** ralphex shows the plan as
  a draft and asks what to do with it (Accept, Revise, Interactive review,
  Reject); none of that reaches the glass. Two of the four cannot happen through
  a browser at all, and the other two are the screen's own two ways on — say
  what is wrong with the plan, or sprout it. A button that only agrees is a
  button that does nothing.
- **The plan file is the finish line, never the process leaving.** Taking the
  draft is what writes it, and the interview does not exit afterwards — it offers
  to work the plan where it stands, so sprouting is what winds one up.
- **A plan that was taken is never lost.** Writing the file is the one part
  ralphex hands to a model, and a model can leave without doing it. The markdown
  that was on the plan screen is what was approved, so it is written out here and
  the seedling grows on it. A draft nobody took is not a plan and is never written.
- **Only what ralphex trips over is a problem with a plan.** Its own prompt
  writes a bare `# Title` and no `## Validation Commands`, so neither is missing
  from a plan Terrarium grew. Never lint a document nobody on this screen wrote.
- **Every run happens in the specimen's own worktree.** `--worktree` is a flag
  Terrarium never builds: the worktree already exists, and it is the specimen.
- **Every stage runs on the cheapest model.** The page never sends one and has no
  control for it; the config fills in the default before anything is spawned.
- **A price is never more than one click from the tokens behind it.** The flow
  shows `est. $x` and nothing else — a token count means nothing to a person, and
  across two models it does not even add up. Clicking it opens the breakdown, per
  model and per stage, and says there that it is an estimate at list prices from a
  dated table. A model with no rate is counted and left unpriced, never costed as zero.
- **The state file is never silently discarded.** Reconciliation adds and updates
  records; it does not delete lifecycle state. New fields are backfilled in place
  so the file stays hand-editable.
- **The lockfile is per-machine and never tracked.** Installs across npm versions
  rewrite it, and a tracked one turns every `git pull` here into a refusal.
- **The foot of the page says which copy this is**, in one grey line: the version
  and the date it moved. The patch number is `git rev-list --count HEAD`, so a
  push updates it and nothing is ever bumped by hand.
- **Git writes are the six in the README and no others.** Five of them stay on
  this machine; one does not. The staging one happens all the time: a
  specimen's worktree is `git add -A`'d when a run stops, when the bench reads
  what landed, and before it is opened in an editor. Reviewing a change means
  reading a diff and reading a diff happens in an editor, so the offer is
  always a staged one.
- **The push is one button, and it asks first.** Everything else here happens
  on this machine and can be undone with a git command; a pushed branch and an
  open merge request are the one thing other people see. So it never happens on
  the way to something else, never on a timer, and never without a dialog
  saying exactly what it is about to do — which branch, into which, called
  what, and how much of the worktree is not committed and so is not in it. The
  same function works out what would happen and what does happen, so the screen
  can never offer a button that refuses for a reason it did not mention.
- **A list of what changed is not a review.** The bench says how big a finished
  run is and where it is waiting — a file count, a commit count, a line the
  developer can act on — and never the files themselves. Naming them costs a
  screenful and buys nothing: the only place a change can actually be read is
  the editor the button opens.
- **A numbered list is not a question unless something says it is.** ralphex's
  review passes print their findings numbered under a stage rule, exactly the
  shape a picker has, and then carry on working — so a question needs a
  sentence above it, the QUESTION protocol around it, the prompt it blocks on
  underneath, or the shape of a draft review. Anything less and a run that
  never stopped is drawn as one waiting on an answer, with the stage rule
  itself as the question. When a real one does arrive mid-run, it says which
  part of the loop asked: a question out of nowhere reads as the loop breaking
  down until it is the review wanting a word.
- **A finished plan says so in two words and then gets out of the way.** *Work
  done*, over the steps it finished, and no paragraph under the buttons
  explaining it — a screen that argues with its own button is worse than one
  that says nothing. While there are steps left the loud button is the one that
  does them.
- **Once it is done, the row is what happens next, in the order it happens.**
  Read it, say what is wrong with it, send it: the editor first and loudest,
  because nobody should send off work they have not opened; the change note in
  the middle; the merge request at the end. There is no bare *grow it again*
  among them — the same finished plan round the loop a second time is not
  something anybody wants. What they want is the bit that is wrong fixed, and
  that is the middle button.
- **How far along it is belongs to the card, not to the bench.** No count of
  steps over the plan and no bar across it: the card already says it by
  growing, on the page you came from, and a modal is not the place to repeat
  it. A step that is done is a tick, not `6/6` struck through — the fraction is
  only worth printing while it is still moving.
- **A list that runs under the edge of its box has to say so.** The plan's steps
  scroll in a quiet area of their own, and that area is exactly as tall as the
  steps in it — a three-step plan in a box sized for twenty reads as a window
  onto more, and someone goes looking for a scroll that does not exist. When
  there really is more, the list fades under a shaded edge and keeps a
  scrollbar that is there before you reach for it.

## Running it

```sh
npm test              # 151 tests, no network, no ralphex needed
npm run typecheck
npm run build && npm start
```

`TERRARIUM_CONFIG=/tmp/somewhere/terrarium.config.json` points a second copy at a scratch
folder while poking at it, so the real one is never disturbed.
