import path from 'node:path';

import {
  createDirectoryWithoutFollowingSymlinks,
  DecisionCode,
  writeFileWithoutFollowingSymlinks,
} from '@exercode/problem-utils';
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
    await writeFixtureFiles(cwd, inputDirectoryPath, testCase.fixtureInput);
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
  const actualTokens = toTokens(actual);
  const expectedTokens = toTokens(expected);
  if (actualTokens.length !== expectedTokens.length) return false;
  return actualTokens.every((token, index) => token === expectedTokens[index]);
}

function toTokens(value: string): string[] {
  return value
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

// This runs as the trusted harness user while `cwd` belongs to the submission, so it must not
// follow a symlink the submission planted at a fixture path (or at one of its parents) — that
// would hand the submission a write to a file only the harness can reach.
async function writeFixtureFiles(cwd: string, basePath: string, files: FixtureInput): Promise<void> {
  await createDirectoryWithoutFollowingSymlinks(cwd, basePath);
  for (const [fileName, content] of Object.entries(files)) {
    await writeFileWithoutFollowingSymlinks(path.join(basePath, fileName), content);
  }
}
