import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { classifyLine, createLineSplitter, MARKERS, stripAnsi } from '../server/ralphex/phases.ts';

test('ANSI is stripped before anything reads the line', () => {
  assert.equal(stripAnsi('\u001B[32mok\u001B[0m'), 'ok');
  assert.equal(stripAnsi('plain'), 'plain');
});

test('a phase carries forward until something changes it', () => {
  const first = classifyLine('starting task execution phase', 'setup');
  assert.equal(first.phase, 'task');
  const second = classifyLine('  edited internal/api/health.go', first.phase);
  assert.equal(second.phase, 'task');
  assert.equal(second.phaseChanged, false);
});

test('review and external review are told apart', () => {
  assert.equal(classifyLine('first code review', 'task').phase, 'review');
  assert.equal(classifyLine('codex iteration 1', 'review').phase, 'external');
  assert.equal(classifyLine('moving plan to completed/', 'external').phase, 'finalize');
});

test("ralphex's documented signals are recognised as markers", () => {
  const done = classifyLine('<<<RALPHEX:ALL_TASKS_DONE>>>', 'task');
  assert.equal(done.marker?.id, 'all_tasks_done');
  assert.equal(done.level, 'success');
  assert.equal(classifyLine('<<<RALPHEX:TASK_FAILED>>>', 'task').level, 'error');
  assert.equal(Object.keys(MARKERS).length, 3);
});

test('a marker settles the level, whatever the words around it say', () => {
  assert.equal(classifyLine('all done <<<RALPHEX:TASK_FAILED>>> passed', 'task').level, 'error');
});

test('failure words colour a line without a marker', () => {
  assert.equal(classifyLine('validation failed, retrying task', 'task').level, 'error');
  assert.equal(classifyLine('rate limit reached, retrying', 'task').level, 'warn');
  assert.equal(classifyLine('validation passed', 'task').level, 'success');
  assert.equal(classifyLine('  edited a file', 'task').level, 'info');
});

test('an unknown previous phase falls back to setup rather than carrying rubbish', () => {
  assert.equal(classifyLine('  something', 'nonsense').phase, 'setup');
});

test('lines are split across chunk boundaries, never truncated', () => {
  const seen: string[] = [];
  const splitter = createLineSplitter((line) => seen.push(line));
  splitter.push('one\ntw');
  splitter.push('o\r\nthree');
  assert.deepEqual(seen, ['one', 'two']);
  splitter.flush();
  assert.deepEqual(seen, ['one', 'two', 'three']);
});

test('flushing nothing emits nothing', () => {
  const seen: string[] = [];
  const splitter = createLineSplitter((line) => seen.push(line));
  splitter.push('done\n');
  splitter.flush();
  splitter.flush();
  assert.deepEqual(seen, ['done']);
});
