import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { findDefaultStdioHarnessFiles, isDefaultStdioHarnessSource } from '../../src/helpers/defaultStdioHarness.js';

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
  [
    'with an aliased import',
    defaultJudgeSource
      .replace('{ stdioJudgePreset }', '{ stdioJudgePreset as run }')
      .replace('await stdioJudgePreset', 'await run'),
    true,
  ],
  ['with a trailing comma in the import', defaultJudgeSource.replace(' }', ', }'), true],
  [
    'with a dollar-sign alias',
    defaultJudgeSource
      .replace('{ stdioJudgePreset }', '{ stdioJudgePreset as $ }')
      .replace('await stdioJudgePreset', 'await $'),
    true,
  ],
  [
    'with a relative specifier',
    defaultJudgeSource.replace('@exercode/problem-utils/presets/stdio', './presets/stdio'),
    false,
  ],
  ['with an explanatory comment', `// This file demonstrates the default harness.\n${defaultJudgeSource}`, false],
  ['with a trailing comment', `${defaultJudgeSource}// custom\n`, false],
  ['with extra logic', `${defaultJudgeSource}console.info('custom');\n`, false],
  ['with a different preset argument', defaultJudgeSource.replace('import.meta.dirname', "'.'"), false],
  ['with the debug preset instead', defaultJudgeSource.replaceAll('stdioJudgePreset', 'stdioDebugPreset'), false],
])('%s -> %s', (_, source, expected) => {
  expect(isDefaultStdioHarnessSource(source, 'stdioJudgePreset')).toBe(expected);
});

const defaultDebugSource = defaultJudgeSource.replaceAll('stdioJudgePreset', 'stdioDebugPreset');

test.each<[string, { 'judge.ts'?: string; 'debug.ts'?: string }, string[]]>([
  ['a standard problem with a default debug.ts', { 'debug.ts': defaultDebugSource }, ['debug.ts']],
  [
    'a custom judge.ts with the mandatory default-content debug.ts',
    { 'judge.ts': `${defaultJudgeSource}console.info('custom');\n`, 'debug.ts': defaultDebugSource },
    [],
  ],
  [
    'default copies of both harnesses',
    { 'judge.ts': defaultJudgeSource, 'debug.ts': defaultDebugSource },
    ['judge.ts', 'debug.ts'],
  ],
])('findDefaultStdioHarnessFiles: %s -> %j', async (_, files, expected) => {
  const problemDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'default_harness_'));
  try {
    for (const [fileName, content] of Object.entries(files)) {
      await fs.promises.writeFile(path.join(problemDir, fileName), content);
    }
    expect(await findDefaultStdioHarnessFiles(problemDir)).toEqual(expected);
  } finally {
    await fs.promises.rm(problemDir, { recursive: true, force: true });
  }
});
