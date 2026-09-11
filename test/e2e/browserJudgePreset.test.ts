import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { expect, test } from 'vitest';

import { DecisionCode, TEST_CASE_RESULT_PREFIX, testCaseResultSchema } from '@exercode/problem-utils';

test('a failure screenshot cannot discard a verdict after the check closes its page', { timeout: 30_000 }, () => {
  const result = spawnSync(
    'bun',
    ['test/fixtures/browserClosedPage/judge.ts', path.resolve('example/web_page_weather/model_answers/default'), '{}'],
    { encoding: 'utf8', timeout: 20_000 }
  );
  expect(result.status, result.stderr).toBe(0);
  const lines = result.stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^TEST_CASE_RESULT /);
  const verdict = testCaseResultSchema.parse(JSON.parse(lines[0]!.slice(TEST_CASE_RESULT_PREFIX.length)));
  expect(verdict).toMatchObject({
    testCaseId: 'closed_page',
    decisionCode: DecisionCode.WRONG_ANSWER,
    feedbackMarkdown: 'The answer is incorrect.',
  });
  expect(verdict.stderr).toContain('Screenshot capture failed:');
  expect(verdict.outputFiles).toBeUndefined();
});

test('browser hooks observe startup and completed checks on a custom entry page', { timeout: 30_000 }, () => {
  const result = spawnSync(
    'bun',
    ['test/fixtures/browserLifecycle/judge.ts', path.resolve('example/web_page_weather/model_answers/default'), '{}'],
    { encoding: 'utf8', timeout: 20_000 }
  );
  expect(result.status, result.stderr).toBe(0);
  const records = result.stdout
    .trim()
    .split('\n')
    .map((line) => {
      expect(line).toMatch(/^TEST_CASE_RESULT /);
      return testCaseResultSchema.parse(JSON.parse(line.slice(TEST_CASE_RESULT_PREFIX.length)));
    });
  expect(records).toMatchObject([
    { testCaseId: 'page', decisionCode: DecisionCode.ACCEPTED, stdout: 'Ready' },
    { testCaseId: 'after', decisionCode: DecisionCode.ACCEPTED, stdout: 'page startup\nChecked' },
  ]);
  expect(records).toHaveLength(2);
});

test('an uncaught browser timeout remains a failure with readable CLI diagnostics', { timeout: 30_000 }, () => {
  const result = spawnSync(
    'bun',
    ['test/fixtures/browserTimeoutJudge.ts', path.resolve('example/web_page_weather/model_answers/default'), '{}'],
    { encoding: 'utf8', timeout: 20_000, env: { ...process.env, FORCE_COLOR: '1' } }
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('TimeoutError:');
  expect(result.stderr).toContain('#missing-submission-element');
  expect(result.stderr).not.toContain('\u001B');
});

test('caught browser timeouts produce readable wrong-answer feedback', { timeout: 30_000 }, () => {
  const result = spawnSync(
    'bun',
    ['test/fixtures/browserTimeoutFeedback.ts', path.resolve('example/web_page_weather/model_answers/default'), '{}'],
    { encoding: 'utf8', timeout: 20_000, env: { ...process.env, FORCE_COLOR: '1' } }
  );
  expect(result.status, result.stderr).toBe(0);
  const lines = result.stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^TEST_CASE_RESULT /);
  const verdict = testCaseResultSchema.parse(JSON.parse(lines[0]!.slice(TEST_CASE_RESULT_PREFIX.length)));
  expect(verdict.decisionCode).toBe(DecisionCode.WRONG_ANSWER);
  expect(verdict.stderr).toContain('#missing-submission-element');
  expect(verdict.stderr).not.toContain('\u001B');
});

test('read-only callback errors keep their original identity and diagnostics', { timeout: 30_000 }, () => {
  const result = spawnSync(
    'bun',
    ['test/fixtures/browserReadonlyErrors.ts', path.resolve('example/web_page_weather/model_answers/default'), '{}'],
    { encoding: 'utf8', timeout: 20_000 }
  );
  expect(result.status, result.stderr).toBe(0);
  expect(
    result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  ).toEqual([
    { sameError: true, name: 'AbortError', message: 'Browser operation aborted' },
    { sameError: true, name: 'Error', message: '\u001B[2mFrozen failure\u001B[22m' },
  ]);
});

test('top-level browser failures print plain diagnostics without forced runtime color', { timeout: 30_000 }, () => {
  const result = spawnSync(
    'bun',
    ['test/fixtures/browserUncaughtTimeout.ts', path.resolve('example/web_page_weather/model_answers/default'), '{}'],
    {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: undefined, CI: undefined, TERM: 'xterm-256color' },
    }
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('#missing-submission-element');
  expect(result.stderr).not.toContain('\u001B');
});
