/* eslint-disable @typescript-eslint/no-unsafe-assignment -- to allow `expect.any */
import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import type { TestCaseResult } from '../../src/types/testCaseResult.js';
import { TEST_CASE_RESULT_PREFIX, testCaseResultSchema } from '../../src/types/testCaseResult.js';

const acceptedTestCaseResultsForAPlusB = [
  {
    testCaseId: '01_small_00',
    decisionCode: 2000,
    exitStatus: 0,
    stdin: '1 1\n',
    stdout: '2\n',
    timeSeconds: expect.any(Number),
    memoryBytes: expect.any(Number),
  },
  {
    testCaseId: '01_small_01',
    decisionCode: 2000,
    exitStatus: 0,
    stdin: '2 3\n',
    stdout: '5\n',
    timeSeconds: expect.any(Number),
    memoryBytes: expect.any(Number),
  },
  {
    testCaseId: '02_large_00',
    decisionCode: 2000,
    exitStatus: 0,
    stdin: '883855166 558951962\n',
    stdout: '1442807128\n',
    timeSeconds: expect.any(Number),
    memoryBytes: expect.any(Number),
  },
  {
    testCaseId: '02_large_01',
    decisionCode: 2000,
    exitStatus: 0,
    stdin: '517836678 497798119\n',
    stdout: '1015634797\n',
    timeSeconds: expect.any(Number),
    memoryBytes: expect.any(Number),
  },
  {
    testCaseId: '03_edge_00',
    decisionCode: 2000,
    exitStatus: 0,
    stdin: '0 0\n',
    stdout: '0\n',
    timeSeconds: expect.any(Number),
    memoryBytes: expect.any(Number),
  },
  {
    testCaseId: '03_edge_01',
    decisionCode: 2000,
    exitStatus: 0,
    stdin: '1000000000 1000000000\n',
    stdout: '2000000000\n',
    timeSeconds: expect.any(Number),
    memoryBytes: expect.any(Number),
  },
  {
    testCaseId: '03_edge_02',
    decisionCode: 2000,
    exitStatus: 0,
    stdin: '0 1000000000\n',
    stdout: '1000000000\n',
    timeSeconds: expect.any(Number),
    memoryBytes: expect.any(Number),
  },
  {
    testCaseId: '03_edge_03',
    decisionCode: 2000,
    exitStatus: 0,
    stdin: '1000000000 0\n',
    stdout: '1000000000\n',
    timeSeconds: expect.any(Number),
    memoryBytes: expect.any(Number),
  },
] as const satisfies readonly TestCaseResult[];

const acceptedTestCaseResultsForAPlusBFile = [
  {
    testCaseId: '01_small_00',
    decisionCode: 2000,
    exitStatus: 0,
    timeSeconds: expect.any(Number),
    memoryBytes: expect.any(Number),
    outputFiles: [{ path: 'c.txt', data: '2\n' }],
  },
  {
    testCaseId: '02_large_00',
    decisionCode: 2000,
    exitStatus: 0,
    timeSeconds: expect.any(Number),
    memoryBytes: expect.any(Number),
    outputFiles: [{ path: 'c.txt', data: '1442807128\n' }],
  },
  {
    testCaseId: '03_edge_00',
    decisionCode: 2000,
    exitStatus: 0,
    timeSeconds: expect.any(Number),
    memoryBytes: expect.any(Number),
    outputFiles: [{ path: 'c.txt', data: '2000000000\n' }],
  },
] as const satisfies readonly TestCaseResult[];

test.each<
  [string, string, string, Record<string, unknown>, Record<string, string | undefined>, readonly TestCaseResult[]]
>([
  // stdioDebugPreset
  [
    'example/a_plus_b',
    'debug.ts',
    'model_answers/java',
    { stdin: '1 1' },
    {},
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

  // stdioJudgePreset
  ['example/a_plus_b', 'judge.ts', 'model_answers/java', {}, {}, acceptedTestCaseResultsForAPlusB],
  ['example/a_plus_b', 'judge.ts', 'model_answers/python', {}, {}, acceptedTestCaseResultsForAPlusB],
  ['example/a_plus_b', 'judge.ts', 'model_answers.test/java_rename', {}, {}, acceptedTestCaseResultsForAPlusB],
  [
    'example/a_plus_b',
    'judge.ts',
    'model_answers.test/python_fpe',
    {},
    {},
    [
      {
        testCaseId: '01_small_00',
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
    'model_answers.test/python_rpe',
    {},
    {},
    [
      {
        testCaseId: '01_small_00',
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
    'model_answers.test/python_tle',
    {},
    {},
    [
      ...acceptedTestCaseResultsForAPlusB.slice(0, 2),
      {
        testCaseId: '02_large_00',
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
    'model_answers.test/python_re',
    {},
    {},
    [
      {
        testCaseId: '01_small_00',
        decisionCode: 1001,
        exitStatus: 1,
        stdin: '1 1\n',
        stderr: expect.stringContaining('ZeroDivisionError'),
        timeSeconds: expect.any(Number),
        memoryBytes: expect.any(Number),
      },
    ],
  ],
  [
    'example/a_plus_b',
    'judge.ts',
    'model_answers.test/python_wa',
    {},
    {},
    [
      {
        testCaseId: '01_small_00',
        decisionCode: 2000,
        exitStatus: 0,
        stdin: '1 1\n',
        stdout: '2\n',
        timeSeconds: expect.any(Number),
        memoryBytes: expect.any(Number),
      },
      {
        testCaseId: '01_small_01',
        decisionCode: 2000,
        exitStatus: 0,
        stdin: '2 3\n',
        stdout: '5\n',
        timeSeconds: expect.any(Number),
        memoryBytes: expect.any(Number),
      },
      {
        testCaseId: '02_large_00',
        decisionCode: 1000,
        exitStatus: 0,
        stdin: '883855166 558951962\n',
        stdout: '8\n',
        timeSeconds: expect.any(Number),
        memoryBytes: expect.any(Number),
      },
    ],
  ],

  ['example/a_plus_b_file', 'judge.ts', 'model_answers/javascript', {}, {}, acceptedTestCaseResultsForAPlusBFile],
  [
    'example/a_plus_b_file',
    'judge.ts',
    'model_answers.test/javascript_mrofe',
    {},
    {},
    [
      {
        testCaseId: '01_small_00',
        decisionCode: 1202,
        exitStatus: 0,
        stdout: '2\n',
        timeSeconds: expect.any(Number),
        memoryBytes: expect.any(Number),
      },
    ],
  ],
  [
    'example/a_plus_b_file',
    'judge.ts',
    'model_answers.test/javascript_wa',
    {},
    {},
    [
      ...acceptedTestCaseResultsForAPlusBFile.slice(0, 1),
      {
        testCaseId: '02_large_00',
        decisionCode: 1000,
        exitStatus: 0,
        timeSeconds: expect.any(Number),
        memoryBytes: expect.any(Number),
        outputFiles: [{ path: 'c.txt', data: '8\n' }],
      },
    ],
  ],

  // llmJudgePreset
  [
    'example/prompt_summary',
    'judge.ts',
    'model_answers/default',
    { model: 'google/gemini-2.5-flash-lite' },
    { GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY },
    [
      {
        testCaseId: '01_small_00',
        decisionCode: 2000,
        stdin: expect.any(String),
        stdout: expect.any(String),
        timeSeconds: expect.any(Number),
      },
      {
        testCaseId: '02_large_00',
        decisionCode: 2000,
        stdin: expect.any(String),
        stdout: expect.any(String),
        timeSeconds: expect.any(Number),
      },
    ],
  ],
  [
    'example/prompt_summary',
    'judge.ts',
    'model_answers.test/wa',
    { model: 'google/gemini-2.5-flash-lite' },
    { GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY },
    [
      {
        testCaseId: '01_small_00',
        decisionCode: 1000,
        stdin: expect.any(String),
        stdout: expect.any(String),
        timeSeconds: expect.any(Number),
      },
    ],
  ],
  [
    'example/prompt_summary',
    'judge.ts',
    'model_answers/default',
    { model: 'google/gemini-2.5-flash-lite' },
    { GOOGLE_GENERATIVE_AI_API_KEY: undefined },
    [
      {
        testCaseId: '01_small_00',
        decisionCode: 1001,
        stdin: expect.any(String),
        stderr:
          "Google Generative AI API key is missing. Pass it using the 'apiKey' parameter or the GOOGLE_GENERATIVE_AI_API_KEY environment variable.",
        timeSeconds: expect.any(Number),
      },
    ],
  ],

  // startHttpServer
  [
    'example/web_page_weather',
    'judge.ts',
    'model_answers/default',
    {},
    {},
    [
      { testCaseId: '01_h1', decisionCode: 2000 },
      { testCaseId: '02_hr', decisionCode: 2000 },
      { testCaseId: '03_p', decisionCode: 2000 },
    ],
  ],
  [
    'example/web_page_weather',
    'judge.ts',
    'model_answers.test/wa',
    {},
    {},
    [
      { testCaseId: '01_h1', decisionCode: 2000 },
      { testCaseId: '02_hr', decisionCode: 2000 },
      {
        testCaseId: '03_p',
        decisionCode: 1000,
        feedbackMarkdown: '`p`タグの件数が一致しません。\n4件必要ですが、3件見つかりました。',
      },
    ],
  ],
])(
  '%s %s %s %j',
  { timeout: 20_000, concurrent: true },
  async (cwd, scriptFilename, argsCwd, argsParams, env, expectedTestCaseResults) => {
    // The target files may be changed during the judging, so clone it before testing.
    await fs.promises.mkdir('temp', { recursive: true });
    const tempDir = await fs.promises.mkdtemp(path.join('temp', 'judge_'));
    await fs.promises.cp(cwd, tempDir, { recursive: true });

    const spawnResult = child_process.spawnSync('bun', ['run', scriptFilename, argsCwd, JSON.stringify(argsParams)], {
      cwd: tempDir,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });

    if (spawnResult.stderr) console.error(spawnResult.stderr);

    const testCaseResults = spawnResult.stdout
      .split('\n')
      .filter((line) => line.startsWith(TEST_CASE_RESULT_PREFIX))
      .map((line) => testCaseResultSchema.parse(JSON.parse(line.slice(TEST_CASE_RESULT_PREFIX.length))));

    expect(testCaseResults).toEqual(expectedTestCaseResults);
  }
);
