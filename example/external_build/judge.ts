import path from 'node:path';

import { DecisionCode, runCommandInTemporaryPackageManagerProject } from '@exercode/problem-utils';
import { commandJudgePreset } from '@exercode/problem-utils/presets/command';

await commandJudgePreset(import.meta.dirname, {
  buildSubmission: false,
  readTestCases: () => Promise.resolve([{ id: 'external_build' }]),
  runCommand: ({ cwd, env, timeLimitSeconds }) =>
    runCommandInTemporaryPackageManagerProject({
      cwd,
      projectDir: path.join(import.meta.dirname, 'judge_project'),
      packageManager: 'npm',
      prepareDependencies: false,
      command: ['node', '-e', String.raw`process.stdout.write("built externally\n")`],
      env,
      timeLimitSeconds,
    }),
  test: ({ runResult }) =>
    runResult.stdout === 'built externally\n' ? undefined : { decisionCode: DecisionCode.WRONG_ANSWER },
});
