import fs from 'node:fs';
import path from 'node:path';

import type { TestCaseResult } from '../types/testCaseResult.js';

import { encodeFileForTestCaseResult } from './printTestCaseResult.js';
import { isContainedPath } from './safeFs.js';
import { sandboxUserName } from './sandboxUser.js';

export async function readOutputFiles(
  cwd: string,
  outputFilePaths: readonly string[]
): Promise<NonNullable<TestCaseResult['outputFiles']>> {
  const outputFiles: NonNullable<TestCaseResult['outputFiles']> = [];
  for (const filePath of outputFilePaths) {
    try {
      const resolvedPath = path.join(cwd, filePath);
      if (!(await isSafeSubmissionOutputPath(cwd, resolvedPath))) continue;
      const buffer = await fs.promises.readFile(resolvedPath);
      outputFiles.push(encodeFileForTestCaseResult(filePath, buffer));
    } catch {
      // file not found
    }
  }
  return outputFiles;
}

/**
 * Whether the harness may read the given submission-created path. When submissions run as the
 * sandbox user while the harness is trusted, a submission could plant a symlink (or a symlinked
 * parent directory) escaping its working directory — e.g. to the 0700 problem directory — and the
 * privileged read would exfiltrate protected bytes, so only paths that resolve inside the working
 * directory are allowed. Without user separation the submission can read those targets itself, so
 * the check is skipped to keep authoring behavior unchanged.
 */
export async function isSafeSubmissionOutputPath(cwd: string, filePath: string): Promise<boolean> {
  if (!sandboxUserName) return true;
  try {
    const realFilePath = await fs.promises.realpath(filePath);
    const realCwd = await fs.promises.realpath(cwd);
    return isContainedPath(realCwd, realFilePath);
  } catch {
    return false;
  }
}
