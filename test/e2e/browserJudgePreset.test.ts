import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { expect, test } from 'vitest';

import { DecisionCode, TEST_CASE_RESULT_PREFIX, testCaseResultSchema } from '@exercode/problem-utils';

test('a failure screenshot cannot discard a verdict after the check closes its page', () => {
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
