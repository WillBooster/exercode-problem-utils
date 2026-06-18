import child_process from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { printDebugBanner } from './printDebugBanner.js';
import type { ResolvedCwd } from './resolveCwds.js';

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
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'problem-utils-isolation_'));
  const copiedProblemDir = path.join(tempRoot, path.basename(problemDir));
  try {
    await fs.promises.cp(problemDir, copiedProblemDir, { recursive: true });

    const relativeCwd = path.relative(problemDir, resolvedCwd.cwd);
    const copiedCwd = path.join(copiedProblemDir, relativeCwd);
    const scriptName = getInvokedScriptName();
    const spawnResult = child_process.spawnSync('bun', ['run', scriptName, copiedCwd, JSON.stringify(params)], {
      cwd: copiedProblemDir,
      encoding: 'utf8',
      env: process.env,
    });

    if (spawnResult.status === 0) {
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
      'The judge did not run after copying only the problem directory to a temporary location.',
      'Make sure judge.ts imports only files included in the problem directory.',
      '',
      `Copied problem dir : ${copiedProblemDir}`,
      `Checked cwd        : ${relativeCwd}`,
      `Exit status        : ${spawnResult.status ?? 'signal'}`,
      '',
      'stdout:',
      spawnResult.stdout.trimEnd() || '<empty>',
      '',
      'stderr:',
      spawnResult.stderr.trimEnd() || '<empty>',
    ]);
    return { passed: false };
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
}

function getInvokedScriptName(): string {
  const scriptPath = process.argv[1];
  return scriptPath ? path.basename(scriptPath) : 'judge.ts';
}
