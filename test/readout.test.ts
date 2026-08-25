import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isMachineryNoise, pendingQuestion, stripLogPrefix, whyItStopped } from '../server/ralphex/readout.ts';

/** ralphex's numbered fallback, as it reaches Terrarium: one line per event. */
function feed(lines: Array<string | { input: string }>) {
  return lines.map((line, i) =>
    typeof line === 'string'
      ? { seq: i + 1, stream: 'stdout', text: line }
      : { seq: i + 1, stream: 'input', text: line.input },
  );
}

test('the sentence above a numbered list is the question', () => {
  const question = pendingQuestion(
    feed(['reading the repo', 'what should it be called?', '  1) health check', '  2) status endpoint']),
  );
  assert.equal(question?.question, 'what should it be called?');
  assert.deepEqual(question?.options.map((o) => o.label), ['health check', 'status endpoint']);
});

test('a QUESTION: label wins when there is no plain line above the list', () => {
  assert.equal(pendingQuestion(feed(['QUESTION: pick a name', '  1) a', '  2) b']))?.question, 'pick a name');
});

test('the escape hatch is marked, so the card can offer a box instead', () => {
  const question = pendingQuestion(feed(['pick', '  1) a', '  2) b', '  3) other (type your own answer)']));
  assert.equal(question?.options.length, 3);
  assert.equal(question?.options[2].other, true);
  assert.equal(question?.options[0].other, false);
});

/**
 * ralphex's draft review is a picker like any other on a terminal, and nothing
 * like one here: two of its four answers cannot happen through a browser at
 * all. It is marked so the flow can answer it with its own two buttons instead
 * of drawing four.
 */
test('the draft review is picked out of an ordinary-looking picker', () => {
  const question = pendingQuestion(
    feed([
      '━━━━━━━━━━━━━━━━━━',
      'Review the plan draft',
      '  1) Accept',
      '  2) Revise',
      '  3) Interactive review',
      '  4) Reject',
    ]),
  );
  assert.deepEqual(question?.review, { accept: 1, revise: 2 });
});

test('a reordered draft review still answers by the right numbers', () => {
  const question = pendingQuestion(feed(['Review the plan draft', '  1) Reject', '  2) Revise', '  3) Accept']));
  assert.deepEqual(question?.review, { accept: 3, revise: 2 });
});

test('an ordinary question is not a draft review', () => {
  const question = pendingQuestion(feed(['pick a name', '  1) health check', '  2) status endpoint']));
  assert.equal(question?.review, null);
});

test('one stray numbered line in prose is not somebody being asked something', () => {
  assert.equal(pendingQuestion(feed(['see 1) the readme for details'])), null);
});

/**
 * The one that stopped a run that had not stopped. A review pass prints its
 * findings numbered, one per line, under its own stage rule — and then goes on
 * working. Read as a picker, that hands the developer a card asking them to
 * choose between two bugs, with the stage rule above it as the question.
 */
test('a review pass listing its findings is a list, not a question', () => {
  const events = feed([
    '--- claude review 0: all findings ---',
    '  1) Missing README.md',
    '  2) Yellow sprinkles insufficient contrast',
  ]);
  assert.equal(pendingQuestion(events), null);
});

test('a stage rule is never the question a list under it is answering', () => {
  const events = feed([
    'what should it be called?',
    '--- task iteration 3 ---',
    '  1) Missing README.md',
    '  2) Yellow sprinkles insufficient contrast',
  ]);
  // The sentence above belongs to what came before the rule, not to this list.
  assert.equal(pendingQuestion(events), null);
});

test('the prompt a picker blocks on makes a bare list a question again', () => {
  const events = feed([
    '--- claude review 0: all findings ---',
    '  1) fix it',
    '  2) leave it',
    'Enter number (1-2):',
  ]);
  assert.equal(pendingQuestion(events)?.question, 'It needs an answer to carry on.');
});

test("ralphex's own asking marker does the same", () => {
  const events = feed(['<<<RALPHEX:QUESTION>>>', '  1) fix it', '  2) leave it']);
  assert.equal(pendingQuestion(events)?.options.length, 2);
});

test('a frame around a question does not take the question away', () => {
  // Furniture is not a stage boundary. A QUESTION: label is ralphex saying
  // outright that it is asking, and a line of box-drawing under it changes
  // nothing about that.
  const events = feed([
    '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501',
    'QUESTION: What should this be called?',
    '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501',
    '  1) health check',
    '  2) status endpoint',
  ]);
  assert.equal(pendingQuestion(events)?.question, 'What should this be called?');
});

test('a plain sentence survives furniture drawn under it', () => {
  const events = feed(['what should it be called?', '\u2501\u2501\u2501\u2501\u2501\u2501', '  1) a', '  2) b']);
  assert.equal(pendingQuestion(events)?.question, 'what should it be called?');
});

test('a draft review under a frame is a question with or without a sentence', () => {
  const events = feed(['\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501', '  1) Accept', '  2) Revise', '  3) Reject']);
  assert.deepEqual(pendingQuestion(events)?.review, { accept: 1, revise: 2 });
});

test('an answered question stops being pending', () => {
  assert.equal(pendingQuestion(feed(['pick', '  1) a', '  2) b', { input: '1' }])), null);
});

test('a second question after an answer is pending again', () => {
  const events = feed(['pick', '  1) a', '  2) b', { input: '1' }, 'and now?', '  1) c', '  2) d']);
  assert.equal(pendingQuestion(events)?.question, 'and now?');
});

test("the progress log's stamped copy of the question is thrown away", () => {
  const events = feed([
    '[25-08-24 11:02:03] asking: what should it be called?',
    'what should it be called?',
    '  1) a',
    '  2) b',
  ]);
  assert.equal(pendingQuestion(events)?.question, 'what should it be called?');
});

test('a stamp is stripped wherever it appears', () => {
  assert.equal(stripLogPrefix('[25-08-24 11:02:03] hello'), 'hello');
  assert.equal(stripLogPrefix('hello'), 'hello');
});

test('a list that restarts at 1 replaces the one before it', () => {
  const question = pendingQuestion(feed(['first?', '  1) a', '  2) b', 'second?', '  1) c', '  2) d']));
  assert.equal(question?.question, 'second?');
});

test('a run still going has no explanation to give', () => {
  assert.equal(whyItStopped({ status: 'running' }, []), null);
  assert.equal(whyItStopped({ status: 'succeeded' }, []), null);
});

test('stopping it yourself is not a failure to explain', () => {
  assert.equal(whyItStopped({ status: 'cancelled' }, []), 'You stopped this run.');
});

test("ralphex's own errors become sentences", () => {
  const events = [{ seq: 1, stream: 'stderr', text: 'error: rate limit exceeded', level: 'error' }];
  assert.match(String(whyItStopped({ status: 'failed' }, events)), /rate limit/i);
});

test('an unrecognised error is tidied, never invented', () => {
  const short = [{ seq: 1, stream: 'stderr', text: 'error: create worktree: disk is full', level: 'error' }];
  // ralphex stacks context onto its errors. Short ones keep it, because
  // without it there is barely a sentence left.
  assert.equal(whyItStopped({ status: 'failed' }, short), 'Create worktree: disk is full.');

  const long = [
    { seq: 1, stream: 'stderr', text: 'error: create worktree: no space left on the device holding it', level: 'error' },
  ];
  assert.equal(whyItStopped({ status: 'failed' }, long), 'No space left on the device holding it.');
});

test('a failure that said nothing says so', () => {
  assert.equal(whyItStopped({ status: 'failed' }, []), 'It stopped without saying why.');
});

test('the progress log’s stamped copy and a picker’s labels are machinery, not the flow', () => {
  // Everything the developer was shown twice, and the protocol wrapped around
  // the question they were shown a third time.
  assert.equal(isMachineryNoise('[26-08-24 09:44:22] DRAFT REVIEW: accept'), true);
  assert.equal(isMachineryNoise('QUESTION: what should I call it?'), true);
  assert.equal(isMachineryNoise('OPTIONS: React, vanilla JS, three.js'), true);
  assert.equal(isMachineryNoise('END'), true);
  assert.equal(isMachineryNoise('progress log: .ralphex/progress/progress-plan-hello.txt'), true);
  assert.equal(isMachineryNoise('Enter number (1-4):'), true);
  assert.equal(isMachineryNoise('<<<RALPHEX:ALL_TASKS_DONE>>>'), true);

  // And what it actually said, which is not.
  assert.equal(isMachineryNoise('reading the repository'), false);
  assert.equal(isMachineryNoise('wrote docs/plans/health-check.md'), false);
  assert.equal(isMachineryNoise('what should this change be called?'), false);
});
