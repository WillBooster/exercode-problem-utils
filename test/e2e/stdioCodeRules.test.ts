import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from 'vitest';

import { DecisionCode } from '../../packages/problem-utils/src/types/decisionCode.js';
import {
  TEST_CASE_RESULT_PREFIX,
  testCaseResultSchema,
} from '../../packages/problem-utils/src/types/testCaseResult.js';

test(
  'stdio judging enforces file and source rules while ignoring comments and non-source assets',
  { timeout: 180_000 },
  async () => {
    await fs.mkdir('.tmp', { recursive: true });
    const root = await fs.mkdtemp(path.resolve('.tmp/stdio-rules-'));
    try {
      const answer = path.join(root, 'answer');
      await fs.mkdir(answer);
      await fs.mkdir(path.join(root, 'test_cases'));
      await fs.writeFile(path.join(root, 'test_cases/example.in'), '');
      await fs.writeFile(path.join(root, 'test_cases/example.out'), '42\n');
      await fs.writeFile(path.join(answer, 'main.js'), '// forbidden\nconsole.log(42);\n');
      await fs.writeFile(path.join(answer, 'asset.txt'), 'forbidden');
      await fs.writeFile(
        path.join(root, 'judge.ts'),
        `import { stdioJudgePreset } from ${JSON.stringify(path.resolve('packages/problem-utils/src/presets/stdio.ts'))};\nawait stdioJudgePreset(import.meta.dirname);\n`
      );
      const judge = async (rules: string): Promise<number> => {
        await fs.writeFile(path.join(root, 'problem.md'), `---\n${rules}\n---\n`);
        const run = childProcess.spawnSync('bun', ['run', 'judge.ts', answer], {
          cwd: root,
          encoding: 'utf8',
          timeout: 20_000,
        });
        expect(run.status, run.stderr).toBe(0);
        const line = run.stdout.split('\n').find((value) => value.startsWith(TEST_CASE_RESULT_PREFIX));
        expect(line).toBeDefined();
        return testCaseResultSchema.parse(JSON.parse(line!.slice(TEST_CASE_RESULT_PREFIX.length))).decisionCode;
      };
      expect(await judge('name: Rules')).toBe(DecisionCode.ACCEPTED);
      expect(await judge('requiredSubmissionFilePaths: [asset.txt]')).toBe(DecisionCode.ACCEPTED);
      await fs.rename(path.join(answer, 'asset.txt'), path.join(answer, 'asset.bin'));
      expect(await judge('requiredSubmissionFilePaths: [asset.txt]')).toBe(
        DecisionCode.MISSING_REQUIRED_SUBMISSION_FILE_ERROR
      );
      expect(await judge('forbiddenTextsInCode: [forbidden]')).toBe(DecisionCode.ACCEPTED);
      expect(await judge('requiredRegExpsInCode: [forbidden]')).toBe(DecisionCode.REQUIRED_PATTERNS_IN_CODE_ERROR);
      await fs.writeFile(path.join(answer, 'main.js'), 'const forbidden = 42; console.log(forbidden);\n');
      expect(await judge('requiredRegExpsInCode: [forbidden]')).toBe(DecisionCode.ACCEPTED);
      expect(await judge('forbiddenTextsInCode: [forbidden]')).toBe(DecisionCode.FORBIDDEN_PATTERNS_IN_CODE_ERROR);
      expect(await judge('forbiddenRegExpsInCode: [forbid.en]')).toBe(DecisionCode.FORBIDDEN_PATTERNS_IN_CODE_ERROR);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);
