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
      // A symlink is followed on purpose: the submission runs as the same OS user as this harness,
      // so it can already read whatever the link points at.
      const buffer = await fs.promises.readFile(path.join(cwd, filePath));
      outputFiles.push(encodeFileForTestCaseResult(filePath, buffer));
    } catch {
      // file not found
    }
  }
  return outputFiles;
}
