import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { expect, test } from 'vitest';

import { DecisionCode, TEST_CASE_RESULT_PREFIX, testCaseResultSchema } from '@exercode/problem-utils';

test('the distributed DOM preset captures console output and exposes submitted functions to verification hooks', () => {
  const result = spawnSync(
    'bun',
    ['test/fixtures/javascriptDom/judge.ts', path.resolve('test/fixtures/javascriptDom/answer'), '{}'],
    { encoding: 'utf8', timeout: 20_000 }
  );
  expect(result.status, result.stderr).toBe(0);
  const lines = result.stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^TEST_CASE_RESULT /);
  const verdict = testCaseResultSchema.parse(JSON.parse(lines[0]!.slice(TEST_CASE_RESULT_PREFIX.length)));
  expect(verdict).toMatchObject({
    testCaseId: 'console',
    decisionCode: DecisionCode.ACCEPTED,
    stdout: 'Browser output\n42',
  });
});
