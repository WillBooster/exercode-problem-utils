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
    const absoluteProblemDir = path.resolve(problemDir);
    const copiedProblemDir = path.join(tempRoot, toTempRelativePath(absoluteProblemDir));
    await fs.promises.mkdir(path.dirname(copiedProblemDir), { recursive: true });
    await fs.promises.cp(absoluteProblemDir, copiedProblemDir, {
      recursive: true,
      filter: isCopiedProblemPath,
    });
    await symlinkAllAncestorNodeModules(tempRoot, absoluteProblemDir);

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
    const paramsJson = JSON.stringify(params);
    const spawnResult = child_process.spawnSync(process.execPath, [...execArgv, scriptPath, copiedCwd, paramsJson], {
      cwd: copiedProblemDir,
      encoding: 'utf8',
      env: process.env,
      timeout: ISOLATION_CHECK_TIMEOUT_MS,
    });
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

function isCopiedProblemPath(src: string): boolean {
  const name = path.basename(src);
  return name !== 'node_modules' && name !== '.git';
}

function isIsolationExecArg(arg: string): boolean {
  return !arg.startsWith('--inspect') && !arg.startsWith('--watch') && !arg.startsWith('--hot');
}

async function symlinkAllAncestorNodeModules(tempRoot: string, problemDir: string): Promise<void> {
  let currentDir = path.resolve(problemDir);
  while (true) {
    const nodeModulesPath = path.join(currentDir, 'node_modules');
    if (fs.existsSync(nodeModulesPath)) {
      const targetSymlinkPath = path.join(tempRoot, toTempRelativePath(currentDir), 'node_modules');
      try {
        await fs.promises.symlink(
          nodeModulesPath,
          targetSymlinkPath,
          process.platform === 'win32' ? 'junction' : 'dir'
        );
      } catch {
        // Package resolution is best-effort; the isolation check still reports a clear spawn failure if imports break.
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
}

function toTempRelativePath(absolutePath: string): string {
  return absolutePath.replace(/^([a-zA-Z]):/, '$1');
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
