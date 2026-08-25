#!/usr/bin/env node
// A stand-in for ralphex, used only by the test suite.
//
// It is a real binary as far as Terrarium is concerned — pointed at through the
// `ralphexCommand` config key — so nothing in the product needs a test seam.
// It speaks the two dialects Terrarium drives: the numbered-picker interview
// behind `--plan`, and the task loop that works a plan file and ticks its
// checkboxes as it commits.
//
// The interview follows the real one line for line, because every one of those
// lines is something Terrarium has to read:
//
//   - a picker is a question, its options, an "Other (type your own answer)"
//     escape hatch, and an "Enter number (1-N): " prompt with no newline on it;
//   - a finished plan is shown as a draft first, framed in heavy rules, and
//     followed by an Accept / Revise / Interactive review / Reject picker —
//     two of whose answers cannot happen through a browser at all;
//   - the plan file is written only once the draft is accepted — and writing it
//     is the one part ralphex hands to a model, so it can be skipped entirely:
//     with FAKE_RALPHEX_NO_WRITE the accepted plan never reaches disk, ralphex
//     finds no plan of its own, says so, and exits cleanly, which is exactly
//     what the real one does when the model leaves without writing;
//   - and then it does not leave. It asks whether to work the plan here, in
//     the checkout it was started from, and waits — which is why potting is
//     what ends an interview, not the process exiting.
//
// The "--- label ---" lines are ralphex's real stage markers: PrintSection
// writes them between phases, with labels from the Section constructors in
// pkg/status. Token usage is attributed to stages by cutting on them, so the
// stand-in has to print them.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const speed = Number(process.env.FAKE_RALPHEX_SPEED ?? 1);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    process.stdout.write(`\nreceived ${signal}, stopping run\n`);
    process.exit(130);
  });
}

const say = (line) => process.stdout.write(`${line}\n`);
/** A prompt ralphex leaves the cursor on: no newline, so it is never a line. */
const prompt = (text) => process.stdout.write(text);
/** The progress log's stamped copy of what the terminal already said. */
const logged = (line) => say(`[26-06-24 11:02:03] ${line}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms * speed));

// One reader over stdin for the whole session, the way ralphex keeps one
// bufio.Reader: a picker's number and the words on the line after it arrive in
// the same write, and a reader made fresh per prompt would throw the second
// line away.
const lines = [];
const waiting = [];
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  const parts = pending.split('\n');
  pending = parts.pop() ?? '';
  for (const line of parts) {
    const next = waiting.shift();
    if (next) next(line);
    else lines.push(line);
  }
});

function readLine() {
  const ready = lines.shift();
  if (ready !== undefined) return Promise.resolve(ready);
  return new Promise((resolve) => waiting.push(resolve));
}

const planIndex = args.indexOf('--plan');
if (planIndex !== -1) await interview(args[planIndex + 1] ?? '');
else await work(args.find((arg) => arg.endsWith('.md')));

/** One numbered picker, answered by number or through the escape hatch. */
async function ask(question, options) {
  const all = [...options, 'Other (type your own answer)'];
  logged(`QUESTION: ${question}`);
  logged(`OPTIONS: ${all.join(', ')}`);
  say('');
  say(question);
  all.forEach((option, i) => say(`  ${i + 1}) ${option}`));
  prompt(`Enter number (1-${all.length}): `);

  const picked = Number((await readLine()).trim());
  const answer =
    picked === all.length || !Number.isInteger(picked) || picked < 1 || picked > all.length
      ? (prompt('Enter your answer: '), (await readLine()).trim())
      : all[picked - 1];
  logged(`ANSWER: ${answer}`);
  return answer;
}

/** `ralphex --plan "<description>"`: ask, draft, and write the plan on accept. */
async function interview(description) {
  say('starting interactive plan creation');
  say(`plan request: ${description}`);

  say('');
  say('--- plan iteration 1 ---');
  say('reading the repository');
  await wait(20);
  const title = await ask('what should this change be called?', ['health check', 'status endpoint']);

  const notes = [];
  for (let iteration = 2; ; iteration += 1) {
    say('');
    say(`--- plan iteration ${iteration} ---`);
    await wait(20);

    // The draft, framed the way ralphex frames one, then the review picker.
    // Nothing is on disk yet: accepting is what writes the file.
    say('');
    say('━━━ Plan Draft ━━━');
    for (const line of draft(title, description, notes)) say(line);
    say('━━━━━━━━━━━━━━━━━━');
    say('');
    say('Review the plan draft');
    for (const [i, option] of ['Accept', 'Revise', 'Interactive review', 'Reject'].entries()) {
      say(`  ${i + 1}) ${option}`);
    }
    prompt('Enter number (1-4): ');

    const action = (await readLine()).trim();
    if (action === '2') {
      prompt('\nEnter revision feedback: ');
      const feedback = (await readLine()).trim();
      logged('DRAFT REVIEW: revise');
      logged(`FEEDBACK: ${feedback}`);
      notes.push(feedback);
      continue;
    }
    if (action === '4') {
      logged('DRAFT REVIEW: reject');
      say('<<<RALPHEX:TASK_FAILED>>>');
      process.exit(1);
    }
    logged('DRAFT REVIEW: accept');
    break;
  }

  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const dir = process.env.FAKE_RALPHEX_PLANS_DIR ?? 'docs/plans';
  const file = join(process.cwd(), dir, `${slug}.md`);
  say('');
  say('--- plan iteration 3 ---');
  await wait(20);

  // The model left without writing the file. ralphex looks for one, finds
  // nothing to implement, and goes — with no offer to work a plan that is not
  // there, and nothing to say for itself but the elapsed time.
  if (process.env.FAKE_RALPHEX_NO_WRITE) {
    say('');
    say('plan creation completed in 4s');
    process.exit(0);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${draft(title, description, notes).join('\n')}\n`);
  say(`wrote ${dir}/${slug}.md`);
  say('<<<RALPHEX:PLAN_READY>>>');
  logged(`plan creation completed in 4s, created ${dir}/${slug}.md`);

  // And then it does not leave: it offers to work the plan there and then, in
  // the checkout it was started from, which is not where the work goes. So it
  // waits here forever while the developer pots the seedling instead.
  say('');
  prompt('Continue with plan implementation? [y/N]: ');
  await readLine();
  await wait(60_000);
  process.exit(0);
}

/**
 * The plan, in the shape ralphex's own prompt writes one: a bare title, an
 * overview, and numbered tasks. No "## Validation Commands" section — that is
 * a convention for plans written by hand, and the interview never writes one.
 */
function draft(title, description, notes) {
  return [
    `# ${title}`,
    '',
    '## Overview',
    description || 'Whatever the developer asked for.',
    ...notes.flatMap((note) => ['', `Revised: ${note}`]),
    '',
    '## Context',
    '- Files involved: `README.md`',
    '',
    '## Implementation Steps',
    '',
    `### Task 1: ${title}`,
    '- [ ] Make the change',
    '- [ ] Cover it with a test',
    '',
    '### Task 2: Verify acceptance criteria',
    '- [ ] Run the test suite and make it pass',
  ];
}

/** `ralphex <plan.md>`: work the plan, ticking a box and committing per task. */
async function work(planPath) {
  say('ralphex starting');
  say('config loaded from ~/.config/ralphex/config');
  if (!planPath || !existsSync(join(process.cwd(), planPath))) {
    process.stderr.write(`error: plan file not found: ${planPath}\n`);
    process.exit(1);
  }
  const file = join(process.cwd(), planPath);
  const boxes = readFileSync(file, 'utf8').split('\n').filter((line) => /^- \[ \]/.test(line)).length;

  say('starting task execution phase');
  for (let i = 1; i <= boxes; i += 1) {
    say('');
    say(`--- task iteration ${i} ---`);
    await wait(20);
    say(`  claude session started (model: haiku)`);
    tickOne(file);
    say('  running validation: npm test');
    say('  validation passed');
    commit(`step ${i}`);
    say(`  committed: step ${i}`);
  }
  say('<<<RALPHEX:ALL_TASKS_DONE>>>');
  say('');
  say('--- review 1: critical/major ---');
  say('  launching 2 agents');
  await wait(20);
  say('  review complete - no more findings');
  say('');
  say('--- finalize ---');
  say('run completed');
  process.exit(0);
}

function tickOne(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const at = lines.findIndex((line) => /^- \[ \]/.test(line));
  if (at === -1) return;
  lines[at] = lines[at].replace('- [ ]', '- [x]');
  writeFileSync(file, lines.join('\n'));
}

function commit(message) {
  const git = (...a) => execFileSync('git', a, { cwd: process.cwd(), stdio: 'ignore' });
  try {
    git('add', '-A');
    git('-c', 'user.email=fake@localhost', '-c', 'user.name=fake', 'commit', '-q', '-m', message);
  } catch {
    /* nothing to commit is fine */
  }
}

