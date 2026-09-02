import fs from 'node:fs';
import path from 'node:path';

import type { TestCaseResult } from '../types/testCaseResult.js';

import { compareStdoutAsSpaceSeparatedTokens } from './compareStdoutAsSpaceSeparatedTokens.js';
import { encodeFileForTestCaseResult } from './printTestCaseResult.js';
import { isSafeSubmissionOutputPath } from './readOutputFiles.js';

type OutputFile = NonNullable<TestCaseResult['outputFiles']>[number];

export interface ExpectedOutputFilesComparison {
  /** Whether every file under the expected directory has a matching file in the working directory. */
  matches: boolean;
  /** Relative paths (from the working directory) of the files that are missing or different. */
  mismatchedPaths: string[];
  /**
   * `<name>_expected.<ext>` / `<name>_received.<ext>` pairs for each mismatched file, in the
   * format Exercode renders side by side. A missing received file yields only the expected entry.
   */
  outputFiles: OutputFile[];
}

/**
 * Compare the files under a test case's `.fout` directory with the files the submission wrote to
 * its working directory. Text files are compared like stdout (space-separated tokens with a
 * numeric tolerance); binary files must match byte for byte.
 */
export async function compareExpectedOutputFiles(
  cwd: string,
  fileOutputPath: string
): Promise<ExpectedOutputFilesComparison> {
  const mismatchedPaths: string[] = [];
  const outputFiles: OutputFile[] = [];
  const dirents = await fs.promises.readdir(fileOutputPath, { withFileTypes: true, recursive: true });
  for (const dirent of dirents.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!dirent.isFile()) continue;

    const relativePath = path.join(path.relative(fileOutputPath, dirent.parentPath), dirent.name);
    const expected = await fs.promises.readFile(path.join(dirent.parentPath, dirent.name));
    const received = await readReceivedFile(cwd, path.join(cwd, relativePath));
    if (received && fileContentsMatch(expected, received)) continue;

    mismatchedPaths.push(relativePath);
    outputFiles.push(encodeFileForTestCaseResult(toComparisonPath(relativePath, 'expected'), expected));
    if (received) outputFiles.push(encodeFileForTestCaseResult(toComparisonPath(relativePath, 'received'), received));
  }
  return { matches: mismatchedPaths.length === 0, mismatchedPaths, outputFiles };
}

/** `c.txt` → `c_expected.txt`; `out/c.txt` → `out/c_expected.txt`. */
export function toComparisonPath(filePath: string, role: 'expected' | 'received'): string {
  const { dir, name, ext } = path.parse(filePath);
  return path.join(dir, `${name}_${role}${ext}`);
}

async function readReceivedFile(cwd: string, receivedPath: string): Promise<Buffer | undefined> {
  try {
    // A submission-planted symlink to the expected file itself would otherwise compare equal.
    if (!(await isSafeSubmissionOutputPath(cwd, receivedPath))) return undefined;
    return await fs.promises.readFile(receivedPath);
  } catch {
    return undefined;
  }
}

function fileContentsMatch(expected: Buffer, received: Buffer): boolean {
  const expectedText = expected.toString('utf8');
  const receivedText = received.toString('utf8');
  const isText = !expectedText.includes('�') && !receivedText.includes('�');
  return isText ? compareStdoutAsSpaceSeparatedTokens(receivedText, expectedText) : received.equals(expected);
}
