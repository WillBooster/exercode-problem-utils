import path from 'node:path';

import { findModelAnswerDirs } from './findModelAnswerDirs.js';
import { printDebugBanner } from './printDebugBanner.js';

export interface ResolvedCwds {
  cwds: readonly string[];
  isDebugMode: boolean;
}

/**
 * Resolve which working directories to judge.
 *
 * - If `cwdArg` is provided, use it as the single cwd.
 * - Otherwise (debug mode), enumerate `<problemDir>/model_answers/*` and judge each.
 *   A prominent banner is printed so users can tell at a glance that this is a debug run.
 *
 * @throws if `cwdArg` is missing and no model answer directories are found.
 */
export async function resolveCwds(problemDir: string, cwdArg: string | undefined): Promise<ResolvedCwds> {
  if (cwdArg) return { cwds: [cwdArg], isDebugMode: false };

  const modelAnswerDirs = await findModelAnswerDirs(problemDir);
  if (modelAnswerDirs.length === 0) {
    throw new Error(
      `cwd argument required (no model answer directories found in ${path.join(problemDir, 'model_answers')})`
    );
  }

  const scriptName = getInvokedScriptName();
  const exampleAnswer = path.relative(problemDir, modelAnswerDirs[0] ?? '') || '<model_answer>';
  printDebugBanner([
    '[DEBUG MODE] cwd not provided -- judging against all model answers',
    '',
    `Problem dir : ${problemDir}`,
    `Model answers (${modelAnswerDirs.length}):`,
    ...modelAnswerDirs.map((dir) => `  - ${path.relative(problemDir, dir)}`),
    '',
    'To judge a single cwd (e.g., a user submission), pass it as the first argument:',
    `  bun ${scriptName} <cwd> [params-json]`,
    'For example:',
    `  bun ${scriptName} ${exampleAnswer}`,
    `  bun ${scriptName} ${exampleAnswer} '{"language":"python"}'`,
  ]);

  return { cwds: modelAnswerDirs, isDebugMode: true };
}

/**
 * Print a per-cwd banner shown before judging each model answer in debug mode.
 * Includes the command for re-running this single cwd.
 */
export function printDebugCwdBanner(problemDir: string, cwd: string): void {
  const relativeCwd = path.relative(problemDir, cwd) || cwd;
  const scriptName = getInvokedScriptName();
  printDebugBanner([
    `[DEBUG MODE] judging: ${relativeCwd}`,
    '',
    'To re-run only this cwd:',
    `  bun ${scriptName} ${relativeCwd}`,
  ]);
}

function getInvokedScriptName(): string {
  const scriptPath = process.argv[1];
  return scriptPath ? path.basename(scriptPath) : 'judge.ts';
}
