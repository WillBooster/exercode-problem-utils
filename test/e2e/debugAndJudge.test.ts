/* eslint-disable @typescript-eslint/no-unsafe-assignment -- to allow `expect.any */
import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import type { TestCaseResult } from '../../src/types/testCaseResult.js';
import { TEST_CASE_RESULT_PREFIX, testCaseResultSchema } from '../../src/types/testCaseResult.js';

const acceptedTestCaseResultsForAPlusB = [
  {
    testCaseId: '01_small_1',
    decisionCode: 2000,
    exitStatus: 0,
    stdin: '1 1\n',
    stdout: '2\n',
    timeSeconds: expect.any(Number),
    memoryBytes: expect.any(Number),
  },
  {
    testCaseId: '01_small_2',
    decisionCode: 2000,
    exitStatus: 0,
    stdin: '2 3\n',
    stdout: '5\n',
    timeSeconds: expect.any(Number),
    memoryBytes: expect.any(Number),
  },
  {
    testCaseId: '02_large_1',
    decisionCode: 2000,
    exitStatus: 0,
    stdin: '883855166 558951962\n',
    stdout: '1442807128\n',
    timeSeconds: expect.any(Number),
    memoryBytes: expect.any(Number),
  },
  {
    testCaseId: '02_large_2',
    decisionCode: 2000,
    exitStatus: 0,
    stdin: '517836678 497798119\n',
    stdout: '1015634797\n',
    timeSeconds: expect.any(Number),
    memoryBytes: expect.any(Number),
  },
  {
    testCaseId: '03_edge_1',
    decisionCode: 2000,
    exitStatus: 0,
    stdin: '0 0\n',
    stdout: '0\n',
    timeSeconds: expect.any(Number),
    memoryBytes: expect.any(Number),
  },
  {
    testCaseId: '03_edge_2',
    decisionCode: 2000,
    exitStatus: 0,
    stdin: '1000000000 1000000000\n',
    stdout: '2000000000\n',
    timeSeconds: expect.any(Number),
    memoryBytes: expect.any(Number),
  },
  {
    testCaseId: '03_edge_3',
    decisionCode: 2000,
    exitStatus: 0,
    stdin: '0 1000000000\n',
    stdout: '1000000000\n',
    timeSeconds: expect.any(Number),
    memoryBytes: expect.any(Number),
  },
  {
    testCaseId: '03_edge_4',
    decisionCode: 2000,
    exitStatus: 0,
    stdin: '1000000000 0\n',
    stdout: '1000000000\n',
    timeSeconds: expect.any(Number),
    memoryBytes: expect.any(Number),
  },
] as const satisfies readonly TestCaseResult[];

test.each<[string, string, Record<string, unknown>, readonly TestCaseResult[]]>([
  [
    'example/a_plus_b',
    'debug.ts',
    { cwd: 'model_answers/java', stdin: '1 1' },
    [
      {
        testCaseId: 'debug',
        decisionCode: 2000,
        exitStatus: 0,
        stdin: '1 1',
        stdout: '2\n',
        timeSeconds: expect.any(Number),
        memoryBytes: expect.any(Number),
      },
    ],
  ],

  ['example/a_plus_b', 'judge.ts', { cwd: 'model_answers/java' }, acceptedTestCaseResultsForAPlusB],
  ['example/a_plus_b', 'judge.ts', { cwd: 'model_answers/python' }, acceptedTestCaseResultsForAPlusB],
  ['example/a_plus_b', 'judge.ts', { cwd: 'test_answers/java_rename' }, acceptedTestCaseResultsForAPlusB],
  [
    'example/a_plus_b',
    'judge.ts',
    { cwd: 'test_answers/python_fpe' },
    [
      {
        testCaseId: '01_small_1',
        decisionCode: 1006,
        feedbackMarkdown: `ソースコード中に禁止された文字列が含まれています。
ソースコードを修正してから再度提出してください。

| ファイル | 禁止パターン | 文字列 |
| -------- | ------------ | ------ |
| \`main.py\` | \`/\\bsum\\s*\\(/g\` | \`sum(\` |
| \`main.py\` | \`some_forbidden_name\` | \`some_forbidden_name\` |
| \`main.py\` | \`some_forbidden_name\` | \`some_forbidden_name\` |
`,
      },
    ],
  ],
  [
    'example/a_plus_b',
    'judge.ts',
    { cwd: 'test_answers/python_rpe' },
    [
      {
        testCaseId: '01_small_1',
        decisionCode: 1007,
        feedbackMarkdown: `ソースコード中に必要な文字列が含まれていません。
ソースコードを修正してから再度提出してください。

- \`/\\+/\`
`,
      },
    ],
  ],
  [
    'example/a_plus_b',
    'judge.ts',
    { cwd: 'test_answers/python_tle' },
    [
      {
        testCaseId: '01_small_1',
        decisionCode: 2000,
        exitStatus: 0,
        stdin: '1 1\n',
        stdout: '2\n',
        timeSeconds: expect.any(Number),
        memoryBytes: expect.any(Number),
      },
      {
        testCaseId: '01_small_2',
        decisionCode: 2000,
        exitStatus: 0,
        stdin: '2 3\n',
        stdout: '5\n',
        timeSeconds: expect.any(Number),
        memoryBytes: expect.any(Number),
      },
      {
        testCaseId: '02_large_1',
        decisionCode: 1002,
        exitStatus: 0,
        stdin: '883855166 558951962\n',
        timeSeconds: expect.any(Number),
        memoryBytes: expect.any(Number),
      },
    ],
  ],
  [
    'example/a_plus_b',
    'judge.ts',
    { cwd: 'test_answers/python_wa' },
    [
      {
        testCaseId: '01_small_1',
        decisionCode: 2000,
        exitStatus: 0,
        stdin: '1 1\n',
        stdout: '2\n',
        timeSeconds: expect.any(Number),
        memoryBytes: expect.any(Number),
      },
      {
        testCaseId: '01_small_2',
        decisionCode: 2000,
        exitStatus: 0,
        stdin: '2 3\n',
        stdout: '5\n',
        timeSeconds: expect.any(Number),
        memoryBytes: expect.any(Number),
      },
      {
        testCaseId: '02_large_1',
        decisionCode: 1000,
        exitStatus: 0,
        stdin: '883855166 558951962\n',
        stdout: '8\n',
        timeSeconds: expect.any(Number),
        memoryBytes: expect.any(Number),
      },
    ],
  ],
])('%s %s %j', { timeout: 10_000, concurrent: true }, async (cwd, scriptFilename, params, expectedTestCaseResults) => {
  // The target files may be changed during the judging, so clone it before testing.
  await fs.promises.mkdir('temp', { recursive: true });
  const tempDir = await fs.promises.mkdtemp(path.join('temp', 'judge_'));
  await fs.promises.cp(cwd, tempDir, { recursive: true });

  const spawnResult = child_process.spawnSync('bun', [scriptFilename, JSON.stringify(params)], {
    cwd: tempDir,
    encoding: 'utf8',
  });

  if (spawnResult.stderr) console.error(spawnResult.stderr);

  const testCaseResults = spawnResult.stdout
    .split('\n')
    .filter((line) => line.startsWith(TEST_CASE_RESULT_PREFIX))
    .map((line) => testCaseResultSchema.parse(JSON.parse(line.slice(TEST_CASE_RESULT_PREFIX.length))));

  expect(testCaseResults).toEqual(expectedTestCaseResults);
});
