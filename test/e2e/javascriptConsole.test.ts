import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { DecisionCode, TEST_CASE_RESULT_PREFIX, testCaseResultSchema } from '@exercode/problem-utils';

test('JavaScript grading preserves console previews in expected output files', { timeout: 30_000 }, () => {
  const fixture = 'test/fixtures/javascriptConsole';
  const result = spawnSync('bun', [path.join(fixture, 'judge.ts'), path.resolve(fixture, 'answer'), '{}'], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  expect(result.status, result.stderr).toBe(0);
  const lines = result.stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^TEST_CASE_RESULT /);
  const verdict = testCaseResultSchema.parse(JSON.parse(lines[0]!.slice(TEST_CASE_RESULT_PREFIX.length)));
  expect(verdict.decisionCode).toBe(DecisionCode.ACCEPTED);
  expect(verdict.stdout?.trimEnd()).toBe(
    fs.readFileSync(path.join(fixture, 'test_cases/console.out'), 'utf8').trimEnd()
  );
});
