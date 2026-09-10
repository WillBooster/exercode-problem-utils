import fs from 'node:fs';
import path from 'node:path';

import type { TestCaseResult } from '../types/testCaseResult.js';

import { encodeFileForTestCaseResult } from './printTestCaseResult.js';

export async function readOutputFiles(
  cwd: string,
  outputFilePaths: readonly string[]
): Promise<NonNullable<TestCaseResult['outputFiles']>> {
  const outputFiles: NonNullable<TestCaseResult['outputFiles']> = [];
  for (const filePath of outputFilePaths) {
    try {
      // Read as-is on purpose: the submission runs as the same OS user as this harness, so a symlink
      // only reaches what it can already read, and a planted FIFO only stalls its own run, which the
      // judge server's request timeout ends.
      const buffer = await fs.promises.readFile(path.join(cwd, filePath));
      outputFiles.push(encodeFileForTestCaseResult(filePath, buffer));
    } catch {
      // file not found
    }
  }
  return outputFiles;
}
