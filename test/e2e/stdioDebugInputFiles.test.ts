import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from 'vitest';

import { selectDebugInputFilePaths } from '../../packages/problem-utils/src/index.js';
import {
  TEST_CASE_RESULT_PREFIX,
  testCaseResultSchema,
} from '../../packages/problem-utils/src/types/testCaseResult.js';

const problemFiles: Record<string, string> = {
  'problem.md': '---\n---\n',
  'model_answers/js/main.js': 'console.log("answer");',
  'test_cases/_shared.fin/members.csv': 'name\n',
  'test_cases/_shared.fin/nested/notes.txt': 'shared\n',
  'test_cases/example_1.in': '1\n',
  'test_cases/example_1.out': '1\n',
  'test_cases/example_3.fin/later.txt': 'example 3\n',
  'test_cases/example_2.fin/members.csv': 'example 2 members\n',
  'test_cases/example_2.fin/visible.txt': 'example 2\n',
  'test_cases/a_hidden.fin/secret.txt': 'hidden\n',
  'test_cases/test_1.fin/secret.txt': 'hidden\n',
  'test_cases/test_1.in': '1\n',
  'test_cases/test_1.out': '1\n',
};

test(
  'a debug run receives exactly the input files selectDebugInputFilePaths selects',
  { timeout: 30_000 },
  async () => {
    const selectedPaths = selectDebugInputFilePaths(Object.keys(problemFiles));
    expect(selectedPaths).toEqual([
      'test_cases/_shared.fin/members.csv',
      'test_cases/_shared.fin/nested/notes.txt',
      'test_cases/example_2.fin/members.csv',
      'test_cases/example_2.fin/visible.txt',
    ]);
    expect(
      selectDebugInputFilePaths(['./test_cases/example_2.fin/visible.txt', './test_cases/test_1.fin/secret.txt'])
    ).toEqual(['./test_cases/example_2.fin/visible.txt']);

    // The example's files overwrite the shared ones at the same path, as in judging.
    expect(await runDebug(problemFiles)).toBe(
      'members.csv=example 2 members\nnested/notes.txt=shared\nvisible.txt=example 2\n'
    );
  }
);

test(
  'a debug run skips an example whose input directory is empty, as selectDebugInputFilePaths does',
  { timeout: 30_000 },
  async () => {
    const files = {
      'problem.md': '---\n---\n',
      'test_cases/example_2.fin/visible.txt': 'example 2\n',
      'test_cases/test_1.fin/secret.txt': 'hidden\n',
    };
    expect(selectDebugInputFilePaths(Object.keys(files))).toEqual(['test_cases/example_2.fin/visible.txt']);
    // Git cannot track an empty directory, so only the fixture can create one.
    expect(await runDebug(files, ['test_cases/example_1.fin'])).toBe('visible.txt=example 2\n');
  }
);

async function runDebug(
  problemFiles: Record<string, string>,
  emptyDirectories: readonly string[] = []
): Promise<string | undefined> {
  await fs.mkdir('.tmp', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.tmp/stdio-debug-input-'));
  try {
    for (const [filePath, data] of Object.entries(problemFiles)) {
      await fs.mkdir(path.dirname(path.join(root, filePath)), { recursive: true });
      await fs.writeFile(path.join(root, filePath), data);
    }
    for (const directory of emptyDirectories) await fs.mkdir(path.join(root, directory), { recursive: true });
    const answer = path.join(root, 'answer');
    await fs.mkdir(answer);
    await fs.writeFile(
      path.join(answer, 'main.js'),
      String.raw`import fs from 'node:fs'; console.log(fs.readdirSync('.', { recursive: true }).filter((p) => p !== 'main.js' && fs.statSync(p).isFile()).toSorted().map((p) => p + '=' + fs.readFileSync(p, 'utf8').trim()).join('\n'));`
    );
    await fs.writeFile(
      path.join(root, 'debug.ts'),
      `import { stdioDebugPreset } from ${JSON.stringify(path.resolve('packages/problem-utils/src/presets/stdio.ts'))};\nawait stdioDebugPreset(import.meta.dirname);\n`
    );
    const run = childProcess.spawnSync('bun', ['run', 'debug.ts', answer, JSON.stringify({ stdin: '' })], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(run.status, run.stderr).toBe(0);
    const line = run.stdout.split('\n').find((value) => value.startsWith(TEST_CASE_RESULT_PREFIX));
    expect(line).toBeDefined();
    return testCaseResultSchema.parse(JSON.parse(line!.slice(TEST_CASE_RESULT_PREFIX.length))).stdout;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
