import { expect, test } from 'vitest';

import { isDefaultStdioHarnessSource } from '../../src/helpers/defaultStdioHarness.js';

const defaultJudgeSource = `import { stdioJudgePreset } from '@exercode/problem-utils/presets/stdio';

await stdioJudgePreset(import.meta.dirname);
`;

test.each<[string, string, boolean]>([
  ['default judge.ts', defaultJudgeSource, true],
  ['without a blank line', defaultJudgeSource.replace('\n\n', '\n'), true],
  ['with double quotes', defaultJudgeSource.replaceAll("'", '"'), true],
  ['without semicolons', defaultJudgeSource.replaceAll(';', ''), true],
  ['with a .js specifier suffix', defaultJudgeSource.replace('/stdio', '/stdio.js'), true],
  ['with the legacy judge-utils specifier', defaultJudgeSource.replace('@exercode/problem-utils', 'judge-utils'), true],
  ['with an explanatory comment', `// This file demonstrates the default harness.\n${defaultJudgeSource}`, false],
  ['with a trailing comment', `${defaultJudgeSource}// custom\n`, false],
  ['with extra logic', `${defaultJudgeSource}console.info('custom');\n`, false],
  ['with a different preset argument', defaultJudgeSource.replace('import.meta.dirname', "'.'"), false],
  ['with the debug preset instead', defaultJudgeSource.replaceAll('stdioJudgePreset', 'stdioDebugPreset'), false],
])('%s -> %s', (_, source, expected) => {
  expect(isDefaultStdioHarnessSource(source, 'stdioJudgePreset')).toBe(expected);
});
