import child_process from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DecisionCode } from '../types/decisionCode.js';
import { TEST_CASE_RESULT_PREFIX, testCaseResultSchema } from '../types/testCaseResult.js';

import { printDebugBanner } from './printDebugBanner.js';
import type { ResolvedCwd } from './resolveCwds.js';

const ISOLATION_CHECK_TIMEOUT_MS = 30_000;

export interface ProblemDirIsolationCheckResult {
  passed: boolean;
}

/**
 * Check that a judge can run after only the problem directory is copied elsewhere.
 */
export async function checkProblemDirIsolation(
  problemDir: string,
  resolvedCwd: ResolvedCwd,
  params: unknown
): Promise<ProblemDirIsolationCheckResult> {
  let tempRoot: string | undefined;
  try {
    tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'problem-utils-isolation_'));
    const copiedProblemDir = path.join(tempRoot, path.basename(problemDir));
    await fs.promises.cp(problemDir, copiedProblemDir, { recursive: true });

    const relativeCwd = path.relative(problemDir, resolvedCwd.cwd);
    const copiedCwd = path.join(copiedProblemDir, relativeCwd);
    const scriptPath = getInvokedScriptPath(problemDir);
    if (scriptPath.startsWith('..') || path.isAbsolute(scriptPath)) {
      printDebugBanner([
        '[DEBUG MODE] isolated problem directory check skipped',
        '',
        'The invoked judge script is located outside the problem directory.',
        `Script path: ${scriptPath}`,
      ]);
      return { passed: true };
    }
    const paramsJson = JSON.stringify(params);
    const spawnResult = child_process.spawnSync(
      process.execPath,
      [...process.execArgv, scriptPath, copiedCwd, paramsJson],
      {
        cwd: copiedProblemDir,
        encoding: 'utf8',
        env: process.env,
        timeout: ISOLATION_CHECK_TIMEOUT_MS,
      }
    );
    const stdout = spawnResult.stdout ?? '';
    const stderr = spawnResult.stderr ?? '';

    if (spawnResult.status === 0 && isAcceptedJudgeOutput(stdout)) {
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
      'The judge did not complete successfully after copying only the problem directory to a temporary location.',
      'Make sure judge.ts imports only files included in the problem directory.',
      '',
      `Copied problem dir : ${copiedProblemDir}`,
      `Checked cwd        : ${relativeCwd}`,
      `Exit status        : ${spawnResult.status ?? spawnResult.signal ?? 'unknown'}`,
      `Spawn error        : ${spawnResult.error?.message ?? '<none>'}`,
      '',
      'stdout:',
      stdout.trimEnd() || '<empty>',
      '',
      'stderr:',
      stderr.trimEnd() || '<empty>',
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
    if (tempRoot) {
      try {
        await fs.promises.rm(tempRoot, { recursive: true, force: true });
      } catch {
        // Cleanup errors should not mask the primary isolation check result.
      }
    }
  }
}

function getInvokedScriptPath(problemDir: string): string {
  const scriptPath = process.argv[1];
  if (!scriptPath) return './judge.ts';
  const relativeScriptPath = path.relative(problemDir, path.resolve(scriptPath));
  return relativeScriptPath.startsWith('.') ? relativeScriptPath : `./${relativeScriptPath}`;
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
