import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { DecisionCode, TEST_CASE_RESULT_PREFIX, testCaseResultSchema } from '@exercode/problem-utils';

test(
  'the distributed DOM preset preserves setup bindings and exposes submitted functions to verification hooks',
  { timeout: 30_000 },
  () => {
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
  }
);

test.each(["throw 'setup failed'", "Promise.reject('setup failed')"])(
  'the distributed DOM preset reports the setup failure reason: %s',
  { timeout: 30_000 },
  (setup) => {
    fs.mkdirSync('.tmp', { recursive: true });
    const fixture = fs.mkdtempSync(path.resolve('.tmp/domSetupError-'));
    try {
      fs.cpSync('test/fixtures/javascriptDom', fixture, { recursive: true });
      fs.writeFileSync(path.join(fixture, 'test_cases/console.in'), setup);
      const result = spawnSync('bun', [path.join(fixture, 'judge.ts'), path.join(fixture, 'answer'), '{}'], {
        encoding: 'utf8',
        timeout: 20_000,
      });
      expect(result.status, result.stderr).toBe(0);
      const lines = result.stdout.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^TEST_CASE_RESULT /);
      const verdict = testCaseResultSchema.parse(JSON.parse(lines[0]!.slice(TEST_CASE_RESULT_PREFIX.length)));
      expect(verdict).toMatchObject({
        testCaseId: 'console',
        decisionCode: DecisionCode.RUNTIME_ERROR,
        stderr: 'setup failed',
      });
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  }
);
