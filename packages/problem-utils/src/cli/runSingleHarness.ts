import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { findDefaultStdioHarnessFiles } from '../helpers/defaultStdioHarness.js';
import { judgesWithoutTestCases, readProblemMarkdownFrontMatter } from '../helpers/readProblemMarkdownFrontMatter.js';
import { readTestCases } from '../helpers/readTestCases.js';
import { stdioDebugPreset, stdioJudgePreset } from '../presets/stdio.js';

export const MISSING_TEST_CASES_ERROR =
  'a standard stdio problem (without judge.ts) needs at least one test case under test_cases/, static-analysis rules (e.g. requiredRegExpsInCode), or isManualScoringRequired';

/**
 * Run the judge or debug harness of the problem in the current working directory: a custom
 * `judge.ts` / `debug.ts` when present, or the default stdio preset otherwise (mirroring the
 * Exercode server, which applies the stdio presets to problems without these files).
 */
export async function runSingleHarness(kind: 'judge' | 'debug'): Promise<number> {
  const problemDir = process.cwd();

  const defaultHarnessFileNames = await findDefaultStdioHarnessFiles(problemDir);
  if (defaultHarnessFileNames.length > 0) {
    console.error(formatDefaultHarnessError(defaultHarnessFileNames));
    return 1;
  }

  const harnessFileName = kind === 'judge' ? 'judge.ts' : 'debug.ts';
  if (fs.existsSync(path.join(problemDir, harnessFileName))) {
    // process.execPath keeps the harness on the same bun executable regardless of PATH.
    const spawnResult = child_process.spawnSync(process.execPath, ['run', harnessFileName, ...process.argv.slice(2)], {
      cwd: problemDir,
      stdio: 'inherit',
    });
    if (spawnResult.error) {
      console.error(`failed to run ${harnessFileName}: ${spawnResult.error.message}`);
      return 1;
    }
    return spawnResult.status ?? 1;
  }

  // A custom judge.ts marks the problem as non-standard, so the stdio debug preset would judge the
  // answer against a contract the problem does not have (mirroring the server, which reports debug
  // as unsupported in this case).
  if (kind === 'debug' && fs.existsSync(path.join(problemDir, 'judge.ts'))) {
    console.error('This problem has a custom judge.ts but no debug.ts; add a debug.ts to support debugging.');
    return 1;
  }

  // Without test cases, stdioJudgePreset prints a single accepted sentinel result, so a standard
  // problem with an empty or missing test_cases/ would otherwise pass without being judged —
  // unless static-analysis rules or manual scoring make the problem judgeable without them.
  if (kind === 'judge') {
    const testCases = await readTestCases(path.join(problemDir, 'test_cases'));
    if (testCases.length === 0 && !judgesWithoutTestCases(await readProblemMarkdownFrontMatter(problemDir))) {
      console.error(MISSING_TEST_CASES_ERROR);
      return 1;
    }
  }

  // The presets read the answer directory and params from `process.argv`, which holds them at the
  // same positions as when a harness script is invoked directly.
  await (kind === 'judge' ? stdioJudgePreset(problemDir) : stdioDebugPreset(problemDir));
  return 0;
}

export function formatDefaultHarnessError(defaultHarnessFileNames: readonly string[]): string {
  const fileNames = defaultHarnessFileNames.join(' and ');
  return `${fileNames} must not be committed because the content is identical to the default stdio harness.
A problem without judge.ts is automatically judged with stdioJudgePreset and debugged with stdioDebugPreset,
so delete ${fileNames} and run the problem with \`bun x exercode-problem judge <answerDir>\` or \`bun x exercode-problem debug <answerDir>\`.
If the file intentionally demonstrates the default harness, add an explanatory comment to mark it as custom.`;
}
