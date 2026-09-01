import path from 'node:path';

import { DecisionCode } from '../types/decisionCode.js';
import { TEST_CASE_RESULT_PREFIX, testCaseResultSchema } from '../types/testCaseResult.js';

import { printDebugBanner } from './printDebugBanner.js';
import type { ResolvedCwd } from './resolveCwds.js';
import { runHarnessProcess } from './runHarnessProcess.js';
import { copyProblemDirToTemporaryRoot, forciblyRemoveDirectory } from './temporaryProblemDirCopy.js';

const ISOLATION_CHECK_MIN_TIMEOUT_MS = 30_000;
// Copying the problem directory, starting bun, and printing results are not covered by the judge's own limits.
const ISOLATION_CHECK_OVERHEAD_MS = 10_000;
const ISOLATION_CHECK_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface ProblemDirIsolationCheckOptions {
  /**
   * The judge's own worst-case duration for one accepted submission (build timeout plus the time
   * limit of every test case). The check never allows less than that, so a judge that respects its
   * declared limits is never killed here.
   */
  expectedMaxDurationMs?: number;
}

export interface ProblemDirIsolationCheckResult {
  passed: boolean;
}

/**
 * Check that a judge can run after only the problem directory is copied elsewhere.
 */
export async function checkProblemDirIsolation(
  problemDir: string,
  resolvedCwd: ResolvedCwd,
  params: unknown,
  options: ProblemDirIsolationCheckOptions = {}
): Promise<ProblemDirIsolationCheckResult> {
  const timeoutMs = Math.max(
    ISOLATION_CHECK_MIN_TIMEOUT_MS,
    (options.expectedMaxDurationMs ?? 0) + ISOLATION_CHECK_OVERHEAD_MS
  );
  let tempRoot: string | undefined;
  try {
    const copyResult = await copyProblemDirToTemporaryRoot(problemDir);
    tempRoot = copyResult.tempRoot;
    const { copiedProblemDir } = copyResult;
    const absoluteProblemDir = path.resolve(problemDir);

    const relativeCwd = path.relative(absoluteProblemDir, path.resolve(resolvedCwd.cwd));
    const copiedCwd = path.join(copiedProblemDir, relativeCwd);
    const scriptPath = getInvokedScriptPath(absoluteProblemDir);
    if (scriptPath.startsWith('..') || path.isAbsolute(scriptPath)) {
      printDebugBanner([
        '[DEBUG MODE] isolated problem directory check skipped',
        '',
        'The invoked judge script is located outside the problem directory.',
        `Script path: ${scriptPath}`,
      ]);
      return { passed: true };
    }
    const execArgv = process.execArgv.filter(isIsolationExecArg);
    const paramsJson = JSON.stringify(isJudgeParamsObject(params) ? params : {});
    const result = await runHarnessProcess([...execArgv, scriptPath, copiedCwd, paramsJson], {
      cwd: copiedProblemDir,
      env: process.env,
      timeoutMs,
      maxOutputBytes: ISOLATION_CHECK_MAX_OUTPUT_BYTES,
      tempRoot,
    });

    if (result.exitCode === 0 && isAcceptedJudgeOutput(result.stdout)) {
      printDebugBanner([
        '[DEBUG MODE] isolated problem directory check passed',
        '',
        `Copied problem dir : ${copiedProblemDir}`,
        `Checked cwd        : ${relativeCwd}`,
      ]);
      return { passed: true };
    }

    printDebugBanner([
      '[DEBUG MODE] isolated problem directory check failed',
      '',
      ...(result.timedOut
        ? [
            `The judge did not finish within ${timeoutMs / 1000} seconds after copying only the problem directory to a temporary location.`,
            'The budget is the build timeout plus the time limit of every test case, plus a fixed overhead.',
            'Check timeLimitMs, the number of test cases, and one-off startup costs such as cold caches.',
          ]
        : [
            'The judge did not complete successfully after copying only the problem directory to a temporary location.',
            'Make sure judge.ts imports only files included in the problem directory.',
          ]),
      '',
      `Copied problem dir : ${copiedProblemDir}`,
      `Checked cwd        : ${relativeCwd}`,
      `Exit status        : ${result.exitCode ?? 'killed'}`,
      `Failure reason     : ${result.failureReason ?? '<none>'}`,
      '',
      'stdout:',
      result.stdout.trimEnd() || '<empty>',
      '',
      'stderr:',
      result.stderr.trimEnd() || '<empty>',
    ]);
    return { passed: false };
  } catch (error) {
    printDebugBanner([
      '[DEBUG MODE] isolated problem directory check failed due to an unexpected error',
      '',
      error instanceof Error ? error.message : String(error),
    ]);
    return { passed: false };
  } finally {
    // Cleanup failures must not mask the primary isolation check result.
    if (tempRoot) await forciblyRemoveDirectory(tempRoot);
  }
}

function isIsolationExecArg(arg: string): boolean {
  return !arg.startsWith('--inspect') && !arg.startsWith('--watch') && !arg.startsWith('--hot');
}

function isJudgeParamsObject(params: unknown): params is object {
  return params !== undefined && params !== null && typeof params === 'object' && !Array.isArray(params);
}

function getInvokedScriptPath(problemDir: string): string {
  const scriptPath = process.argv[1];
  if (!scriptPath) return `.${path.sep}judge.ts`;
  const relativeScriptPath = path.relative(problemDir, path.resolve(scriptPath));
  if (path.isAbsolute(relativeScriptPath)) return relativeScriptPath;
  return relativeScriptPath.startsWith('.') ? relativeScriptPath : `.${path.sep}${relativeScriptPath}`;
}

function isAcceptedJudgeOutput(stdout: string): boolean {
  const resultLines = stdout.split(/\r?\n/).filter((line) => line.startsWith(TEST_CASE_RESULT_PREFIX));
  if (resultLines.length === 0) return false;

  return resultLines.every((line) => {
    try {
      const parsedResult = testCaseResultSchema.safeParse(JSON.parse(line.slice(TEST_CASE_RESULT_PREFIX.length)));
      return parsedResult.success && parsedResult.data.decisionCode === DecisionCode.ACCEPTED;
    } catch {
      return false;
    }
  });
}
