import fs from 'node:fs/promises';
import path from 'node:path';

import { DecisionCode } from '@exercode/problem-utils';
import { commandJudgePreset } from '@exercode/problem-utils/presets/command';

interface FixtureInput {
  [fileName: string]: string;
}

interface CommandExampleTestCase {
  id: string;
  fixtureInput: FixtureInput;
  expected: string;
}

const FIXTURE_ROOT = 'temp';

const TEST_CASES: readonly CommandExampleTestCase[] = [
  {
    id: 'smallest',
    fixtureInput: {
      'readme.txt': 'alpha',
      'notes.txt': 'beta-beta',
      'main.txt': 'gamma-gamma-gamma',
    },
    expected: 'readme.txt',
  },
  {
    id: 'symbols',
    fixtureInput: {
      'short.txt': 'x',
      'middle.txt': 'yy',
      'long.txt': 'zzz',
    },
    expected: 'short.txt',
  },
];

await commandJudgePreset<CommandExampleTestCase>(import.meta.dirname, {
  readTestCases: async () =>
    TEST_CASES.map((testCase) => ({
      id: testCase.id,
      fixtureInput: testCase.fixtureInput,
      expected: testCase.expected,
    })),
  resolveInput: async ({ testCase, cwd }) => {
    const inputDirectoryPath = path.join(cwd, FIXTURE_ROOT, testCase.id);
    await writeFixtureFiles(inputDirectoryPath, testCase.fixtureInput);
    return path.relative(cwd, inputDirectoryPath);
  },
  test: ({ runResult, testCase }) => {
    return tokensEqual(runResult.stdout, testCase.expected)
      ? { decisionCode: DecisionCode.ACCEPTED }
      : {
          decisionCode: DecisionCode.WRONG_ANSWER,
          feedbackMarkdown: `期待したファイル名: \`${testCase.expected}\``,
        };
  },
});

function tokensEqual(actual: string, expected: string): boolean {
  const toTokens = (value: string) =>
    value
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 0);
  const actualTokens = toTokens(actual);
  const expectedTokens = toTokens(expected);
  if (actualTokens.length !== expectedTokens.length) return false;
  return actualTokens.every((token, index) => token === expectedTokens[index]);
}

async function writeFixtureFiles(basePath: string, files: FixtureInput): Promise<void> {
  await fs.mkdir(basePath, { recursive: true });
  for (const [fileName, content] of Object.entries(files)) {
    await fs.writeFile(path.join(basePath, fileName), content);
  }
}
