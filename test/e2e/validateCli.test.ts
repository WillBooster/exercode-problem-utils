import child_process from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { cleanupTempDirs, createTempDir, learningMaterialFixturesDir } from '../unit/learningMaterialTestHelpers.js';

const cliPath = path.resolve('src/cli/exercodeProblem.ts');
const problemsDir = path.join(learningMaterialFixturesDir, 'problems');

describe('exercode-problem validate-* CLI', () => {
  afterEach(cleanupTempDirs);

  test('validate-problem succeeds for the valid fixtures', () => {
    const result = runCli([
      'validate-problem',
      path.join(problemsDir, 'a_plus_b'),
      path.join(problemsDir, 'arithmetic_subtraction'),
    ]);
    expect(result.stdout).toContain('a_plus_b: OK');
    expect(result.stdout).toContain('arithmetic_subtraction: OK');
    expect(result.status).toBe(0);
  });

  test('validate-problem fails with exit code 1 for a broken problem', async () => {
    const brokenProblemDir = path.join(await createTempDir(), 'broken_problem');
    await mkdir(brokenProblemDir);
    const result = runCli(['validate-problem', brokenProblemDir]);
    expect(result.stdout).toContain('error: problem.md not found');
    expect(result.status).toBe(1);
  });

  test('validate-course succeeds for the valid fixture with --problems-dir', () => {
    const courseDir = path.join(learningMaterialFixturesDir, 'courses', 'example_course');
    const result = runCli(['validate-course', courseDir, '--problems-dir', problemsDir]);
    expect(result.stdout).toContain('example_course: OK');
    expect(result.status).toBe(0);
  });

  test('validate-contest succeeds for the valid fixture with --problems-dir', () => {
    const contestPath = path.join(learningMaterialFixturesDir, 'contests', 'sample_contest.contest.yaml');
    const result = runCli(['validate-contest', contestPath, '--problems-dir', problemsDir]);
    expect(result.stdout).toContain('sample_contest.contest.yaml: OK');
    expect(result.status).toBe(0);
  });
});

function runCli(args: string[]): child_process.SpawnSyncReturns<string> {
  return child_process.spawnSync('bun', ['run', cliPath, ...args], { encoding: 'utf8', timeout: 60_000 });
}
