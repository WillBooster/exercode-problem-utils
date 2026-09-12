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

test.each(['bun', 'node'])(
  'read-only callback errors retain identity and clean writable stacks in %s',
  { timeout: 30_000 },
  (runtime) => {
    const result = spawnSync(
      runtime,
      ['test/fixtures/browserReadonlyErrors.ts', path.resolve('example/web_page_weather/model_answers/default'), '{}'],
      { encoding: 'utf8', timeout: 20_000 }
    );
    expect(result.status, result.stderr).toBe(0);
    const errors = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(errors).toHaveLength(2);
    expect(errors).toMatchObject([
      { sameError: true, name: 'AbortError', message: '\u001B[2mBrowser operation aborted\u001B[22m' },
      { sameError: true, name: 'Error', message: '\u001B[2mFrozen failure\u001B[22m' },
    ]);
    expect(errors[0].stack ?? '').not.toContain('\u001B');
  }
);

test('top-level browser failures print plain diagnostics without forced runtime color', { timeout: 30_000 }, () => {
  const result = spawnSync(
    'bun',
    ['test/fixtures/browserUncaughtTimeout.ts', path.resolve('example/web_page_weather/model_answers/default'), '{}'],
    {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: undefined, TERM: 'xterm-256color' },
    }
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('#missing-submission-element');
  expect(result.stderr).not.toContain('\u001B');
});

test('a blocked renderer cannot discard a verdict while capturing its failure screenshot', { timeout: 30_000 }, () => {
  const result = spawnSync(
    'bun',
    [
      'test/fixtures/browserBlockedRenderer/judge.ts',
      path.resolve('example/web_page_weather/model_answers/default'),
      '{}',
    ],
    { encoding: 'utf8', timeout: 20_000 }
  );
  expect(result.status, result.stderr).toBe(0);
  const lines = result.stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^TEST_CASE_RESULT /);
  const verdict = testCaseResultSchema.parse(JSON.parse(lines[0]!.slice(TEST_CASE_RESULT_PREFIX.length)));
  expect(verdict).toMatchObject({
    testCaseId: 'blocked_renderer',
    decisionCode: DecisionCode.WRONG_ANSWER,
    feedbackMarkdown: 'The required element is missing.',
  });
  expect(verdict.stderr).toContain('Screenshot capture failed:');
  expect(verdict.stderr).toContain('200 ms');
  expect(verdict.outputFiles).toBeUndefined();
});

test.each([
  ['default', '{"confirmed":false,"value":null,"handledDialogs":0}'],
  ['once', '{"confirmed":false,"value":null,"handledDialogs":1}'],
  ['custom', '{"confirmed":true,"value":"learner input","handledDialogs":3}'],
] as const)('browser grading completes with %s dialog handling', { timeout: 30_000 }, (mode, expected) => {
  const result = spawnSync('bun', ['test/fixtures/browserDialogs/judge.ts', '.', '{}', mode], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  expect(result.status, result.stderr).toBe(0);
  const lines = result.stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^TEST_CASE_RESULT /);
  const verdict = testCaseResultSchema.parse(JSON.parse(lines[0]!.slice(TEST_CASE_RESULT_PREFIX.length)));
  expect(verdict.decisionCode).toBe(DecisionCode.ACCEPTED);
  expect(verdict.stdout).toBe(expected);
});
