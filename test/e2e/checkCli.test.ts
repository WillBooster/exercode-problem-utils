import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, expect, test } from 'vitest';

const cliPath = path.resolve('packages/problem-utils/src/cli/exercodeProblem.ts');

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((tempRoot) => fs.promises.rm(tempRoot, { recursive: true, force: true })));
});

function runCheck(rootDir: string): child_process.SpawnSyncReturns<string> {
  // The synchronous spawn blocks Vitest's timers, so enforce the deadline on the child itself;
  // SIGTERM lets the CLI's signal handlers tear down harness process groups and temp copies.
  return child_process.spawnSync('bun', ['run', cliPath, rootDir], { encoding: 'utf8', timeout: 110_000 });
}

async function copyProblemToTempRoot(): Promise<string> {
  await fs.promises.mkdir('temp', { recursive: true });
  const tempRoot = await fs.promises.mkdtemp(path.join('temp', 'check_'));
  tempRoots.push(tempRoot);
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

// Code rules and required submission files check the submission once; they do not replace the
// per-case output comparison. The rules fail the model answer, so the authoring error must surface
// before the static analysis.
test.each(["requiredRegExpsInCode: ['no_such_token']", "requiredSubmissionFilePaths: ['missing.txt']"])(
  'check rejects a problem with %s whose test case lacks an expected output',
  { timeout: 120_000 },
  async (frontMatterLine) => {
    const tempRoot = await copyProblemToTempRoot();
    const problemDir = path.join(tempRoot, 'a_plus_b_file');
    const problemFilePath = path.join(problemDir, 'problem.md');
    const problemFile = await fs.promises.readFile(problemFilePath, 'utf8');
    await fs.promises.writeFile(
      problemFilePath,
      problemFile.replace("requiredOutputFilePaths: ['c.txt']", frontMatterLine)
    );
    await fs.promises.rm(path.join(problemDir, 'test_cases', 'test_1.fout'), { recursive: true });

    const result = runCheck(tempRoot);

    expect(result.stderr).toContain('test case test_1 needs an expected output');
    expect(result.status).toBe(1);
  }
);

test(
  'check accepts a required-output-files problem whose test case has no expected output',
  { timeout: 120_000 },
  async () => {
    const tempRoot = await copyProblemToTempRoot();
    // The presence of the required output file judges such a case.
    await fs.promises.rm(path.join(tempRoot, 'a_plus_b_file', 'test_cases', 'test_1.fout'), { recursive: true });

    const result = runCheck(tempRoot);

    if (result.stderr) console.error(result.stderr);
    expect(result.stdout).toContain('1 passed, 0 failed');
    expect(result.status).toBe(0);
  }
);

test.each(['SIGINT', 'SIGTERM', 'SIGKILL'] as const)(
  'check removes HTML serving files after a harness receives %s',
  { timeout: 120_000 },
  async (signal) => {
    const tempRoot = await copyProblemToTempRoot();
    const marker = path.resolve(tempRoot, 'served-directory.txt');
    const problemDir = path.join(tempRoot, 'a_plus_b_file');
    await fs.promises.writeFile(
      path.join(problemDir, 'judge.ts'),
      `import { writeFileSync } from 'node:fs';
import { createHtmlServedDirectory } from '@exercode/problem-utils-browser';
const directory = await createHtmlServedDirectory(process.argv[2]);
writeFileSync(${JSON.stringify(marker)}, directory.path);
process.kill(process.pid, ${JSON.stringify(signal)});
`
    );
    const result = runCheck(tempRoot);
    const servedDirectory = await fs.promises.readFile(marker, 'utf8');
    try {
      expect(result.status, result.stderr).toBe(1);
      expect(fs.existsSync(servedDirectory)).toBe(false);
      expect(fs.existsSync(path.join(problemDir, 'model_answers', 'javascript', 'main.mjs'))).toBe(true);
    } finally {
      await fs.promises.rm(servedDirectory, { recursive: true, force: true });
    }
  }
);

test('check skips a valid agent challenge and fails an invalid or unexplained one', { timeout: 120_000 }, async () => {
  await fs.promises.mkdir('temp', { recursive: true });
  const tempRoot = await fs.promises.mkdtemp(path.join('temp', 'check_'));
  tempRoots.push(tempRoot);
  const writeAgentChallenge = async (name: string, method: string, hasExplanation: boolean): Promise<void> => {
    const problemDir = path.join(tempRoot, name);
    await fs.promises.mkdir(path.join(problemDir, 'model_answers', 'explanation'), { recursive: true });
    await fs.promises.writeFile(
      path.join(problemDir, 'problem.md'),
      `---\nname: ${name}\nagentChallenge:\n  playgrounds: [bbs]\n  expectedRequest:\n    method: ${method}\n    path: /messages\n---\n\nPost a greeting.\n`
    );
    if (hasExplanation) {
      await fs.promises.writeFile(path.join(problemDir, 'model_answers', 'explanation', 'explanation.md'), '# 解説\n');
    }
  };
  await writeAgentChallenge('valid', 'POST', true);

  const validResult = runCheck(tempRoot);

  expect(validResult.stdout).toContain('0 passed, 0 failed (0 runs, 1 problems, agent challenges skipped: 1)');
  expect(validResult.status).toBe(0);

  await writeAgentChallenge('invalid', 'post', true);
  await writeAgentChallenge('unexplained', 'POST', false);

  const invalidResult = runCheck(tempRoot);

  expect(invalidResult.stderr).toContain('✗ invalid: invalid agentChallenge');
  expect(invalidResult.stderr).toContain('✗ unexplained: no explanation found');
  expect(invalidResult.status).toBe(1);
});
