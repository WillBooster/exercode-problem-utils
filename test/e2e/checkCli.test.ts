import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

const cliPath = path.resolve('src/cli/exercode.ts');

function runCheck(rootDir: string): child_process.SpawnSyncReturns<string> {
  // The synchronous spawn blocks Vitest's timers, so enforce the deadline on the child itself;
  // SIGTERM lets the CLI's signal handlers tear down harness process groups and temp copies.
  return child_process.spawnSync('bun', ['run', cliPath, rootDir], { encoding: 'utf8', timeout: 110_000 });
}

async function copyProblemToTempRoot(): Promise<string> {
  await fs.promises.mkdir('temp', { recursive: true });
  const tempRoot = await fs.promises.mkdtemp(path.join('temp', 'check_'));
  const problemDir = path.join(tempRoot, 'a_plus_b_file');
  await fs.promises.cp('example/a_plus_b_file', problemDir, { recursive: true });
  return tempRoot;
}

test('check judges model_answers and model_answers.fails of all problems', { timeout: 120_000 }, async () => {
  const tempRoot = await copyProblemToTempRoot();
  const problemDir = path.join(tempRoot, 'a_plus_b_file');
  // A wrong answer under model_answers.fails must be reported as passing (it fails as expected).
  await fs.promises.cp(
    path.join(problemDir, 'model_answers.test', 'javascript_wa'),
    path.join(problemDir, 'model_answers.fails', 'javascript_wa'),
    { recursive: true }
  );

  const result = runCheck(tempRoot);

  if (result.stderr) console.error(result.stderr);
  expect(result.stdout).toContain('✓ a_plus_b_file model_answers/javascript');
  expect(result.stdout).toContain('✓ a_plus_b_file model_answers.fails/javascript_wa');
  expect(result.stdout).toContain('2 passed, 0 failed (2 runs, 1 problems)');
  expect(result.status).toBe(0);
});

test('check rejects a committed copy of the default stdio harness', { timeout: 120_000 }, async () => {
  const tempRoot = await copyProblemToTempRoot();
  await fs.promises.writeFile(
    path.join(tempRoot, 'a_plus_b_file', 'judge.ts'),
    `import { stdioJudgePreset } from '@exercode/problem-utils/presets/stdio';\n\nawait stdioJudgePreset(import.meta.dirname);\n`
  );

  const result = runCheck(tempRoot);

  expect(result.stderr).toContain('judge.ts must not be committed');
  expect(result.status).toBe(1);
});

test('check rejects a standard problem without test cases', { timeout: 120_000 }, async () => {
  const tempRoot = await copyProblemToTempRoot();
  await fs.promises.rm(path.join(tempRoot, 'a_plus_b_file', 'test_cases'), { recursive: true });

  const result = runCheck(tempRoot);

  expect(result.stderr).toContain('needs at least one test case');
  expect(result.status).toBe(1);
});

test('check reports a model answer that fails a test case', { timeout: 120_000 }, async () => {
  const tempRoot = await copyProblemToTempRoot();
  const problemDir = path.join(tempRoot, 'a_plus_b_file');
  await fs.promises.rm(path.join(problemDir, 'model_answers', 'javascript'), { recursive: true });
  await fs.promises.cp(
    path.join(problemDir, 'model_answers.test', 'javascript_wa'),
    path.join(problemDir, 'model_answers', 'javascript_wa'),
    { recursive: true }
  );

  const result = runCheck(tempRoot);

  expect(result.stderr).toContain('WRONG_ANSWER on test case');
  expect(result.stdout).toContain('0 passed, 1 failed');
  expect(result.status).toBe(1);
});
