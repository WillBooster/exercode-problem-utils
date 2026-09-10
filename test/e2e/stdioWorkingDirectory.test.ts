import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from 'vitest';

import {
  TEST_CASE_RESULT_PREFIX,
  testCaseResultSchema,
} from '../../packages/problem-utils/src/types/testCaseResult.js';

for (const disposableWorkingDirectory of [false, true]) {
  test(
    `stdio debug executes with disposableWorkingDirectory=${disposableWorkingDirectory}`,
    { timeout: 30_000 },
    async () => {
      await fs.mkdir('.tmp', { recursive: true });
      const root = await fs.mkdtemp(path.resolve('.tmp/stdio-debug-'));
      try {
        const answer = path.join(root, 'answer');
        await fs.mkdir(answer);
        await fs.writeFile(path.join(root, 'problem.md'), '---\nrequiredOutputFilePaths: [result.txt]\n---\n');
        await fs.writeFile(
          path.join(answer, 'main.js'),
          "await Bun.write('result.txt', 'saved'); console.log(await Bun.stdin.text());"
        );
        await fs.writeFile(
          path.join(root, 'debug.ts'),
          `import { stdioDebugPreset } from ${JSON.stringify(path.resolve('packages/problem-utils/src/presets/stdio.ts'))};\nawait stdioDebugPreset(import.meta.dirname, { disposableWorkingDirectory: ${disposableWorkingDirectory} });\n`
        );
        const run = childProcess.spawnSync('bun', ['run', 'debug.ts', answer, JSON.stringify({ stdin: 'hello' })], {
          cwd: root,
          encoding: 'utf8',
          timeout: 20_000,
        });
        expect(run.status, run.stderr).toBe(0);
        const line = run.stdout.split('\n').find((value) => value.startsWith(TEST_CASE_RESULT_PREFIX));
        expect(line).toBeDefined();
        const result = testCaseResultSchema.parse(JSON.parse(line!.slice(TEST_CASE_RESULT_PREFIX.length)));
        expect(result).toMatchObject({
          decisionCode: 2000,
          stdout: 'hello\n',
          outputFiles: [{ path: 'result.txt', data: 'saved' }],
        });
        expect(await fs.readFile(path.join(answer, 'main.js'), 'utf8')).toContain('console.log');
        if (disposableWorkingDirectory) {
          expect(await fs.readFile(path.join(answer, 'result.txt'), 'utf8')).toBe('saved');
        } else {
          await expect(fs.stat(path.join(answer, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  );
}
