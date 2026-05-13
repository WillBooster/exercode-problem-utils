import path from 'node:path';

import { findFailingModelAnswerDirs, findModelAnswerDirs } from './findModelAnswerDirs.js';
import { printDebugBanner } from './printDebugBanner.js';

export type ExpectedJudgeResult = 'accepted' | 'rejected';

export interface ResolvedCwd {
  cwd: string;
  expectedResult: ExpectedJudgeResult;
}

export interface ResolvedCwds {
  cwds: readonly ResolvedCwd[];
  isDebugMode: boolean;
}

/**
 * Resolve which working directories to judge.
 *
 * - If `cwdArg` is provided, use it as the single cwd.
 * - Otherwise (debug mode), enumerate `<problemDir>/model_answers/*` and
 *   `<problemDir>/model_answers.fails/*` and judge each.
 *   A prominent banner is printed so users can tell at a glance that this is a debug run.
 *
 * @throws if `cwdArg` is missing and no model answer directories are found.
 */
export async function resolveCwds(problemDir: string, cwdArg: string | undefined): Promise<ResolvedCwds> {
  if (cwdArg) return { cwds: [{ cwd: cwdArg, expectedResult: 'accepted' }], isDebugMode: false };

  const modelAnswerDirs = await findModelAnswerDirs(problemDir);
  const failingModelAnswerDirs = await findFailingModelAnswerDirs(problemDir);
  if (modelAnswerDirs.length === 0 && failingModelAnswerDirs.length === 0) {
    throw new Error(
      `cwd argument required (no model answer directories found in ${path.join(problemDir, 'model_answers')} or ${path.join(problemDir, 'model_answers.fails')})`
    );
  }

  const scriptName = getInvokedScriptName();
  const exampleAnswer =
    path.relative(problemDir, modelAnswerDirs[0] ?? failingModelAnswerDirs[0] ?? '') || '<model_answer>';
  printDebugBanner([
    '[DEBUG MODE] cwd not provided -- judging against all model answers',
    '',
    `Problem dir : ${problemDir}`,
    `Model answers (${modelAnswerDirs.length}):`,
    ...modelAnswerDirs.map((dir) => `  - ${path.relative(problemDir, dir)}`),
    `Failing model answers (${failingModelAnswerDirs.length}):`,
    ...failingModelAnswerDirs.map((dir) => `  - ${path.relative(problemDir, dir)}`),
    '',
    'To judge a single cwd (e.g., a user submission), pass it as the first argument:',
    `  bun ${scriptName} <cwd> [params-json]`,
    'For example:',
    `  bun ${scriptName} ${exampleAnswer}`,
    `  bun ${scriptName} ${exampleAnswer} '{"language":"python"}'`,
  ]);

  return {
    cwds: [
      ...modelAnswerDirs.map((cwd) => ({ cwd, expectedResult: 'accepted' as const })),
      ...failingModelAnswerDirs.map((cwd) => ({ cwd, expectedResult: 'rejected' as const })),
    ],
    isDebugMode: true,
  };
}

/**
 * Print a per-cwd banner shown before judging each model answer in debug mode.
 * Includes the command for re-running this single cwd.
 */
export function printDebugCwdBanner(problemDir: string, resolvedCwd: ResolvedCwd): void {
  const relativeCwd = path.relative(problemDir, resolvedCwd.cwd) || resolvedCwd.cwd;
  const scriptName = getInvokedScriptName();
  printDebugBanner([
    `[DEBUG MODE] judging: ${relativeCwd}`,
    `Expected result: ${resolvedCwd.expectedResult}`,
    '',
    'To judge only this cwd as a normal submission:',
    `  bun ${scriptName} ${relativeCwd}`,
    'Run without a cwd to check debug-mode expectations.',
  ]);
}

export function printDebugExpectationFailureBanner(problemDir: string, resolvedCwd: ResolvedCwd): void {
  const relativeCwd = path.relative(problemDir, resolvedCwd.cwd) || resolvedCwd.cwd;
  printDebugBanner([
    `[DEBUG MODE] expectation failed: ${relativeCwd}`,
    `Expected result: ${resolvedCwd.expectedResult}`,
    resolvedCwd.expectedResult === 'accepted'
      ? 'The model answer was rejected by the judge.'
      : 'The failing model answer was accepted by the judge.',
  ]);
}

function getInvokedScriptName(): string {
  const scriptPath = process.argv[1];
  return scriptPath ? path.basename(scriptPath) : 'judge.ts';
}
