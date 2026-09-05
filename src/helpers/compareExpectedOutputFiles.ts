import fs from 'node:fs';
import path from 'node:path';

import type { TestCaseResult } from '../types/testCaseResult.js';

import { compareStdoutAsSpaceSeparatedTokens } from './compareStdoutAsSpaceSeparatedTokens.js';
import { encodeFileForTestCaseResult } from './printTestCaseResult.js';

type OutputFile = NonNullable<TestCaseResult['outputFiles']>[number];

// Bound what the harness reads and reports.
export const MAX_COMPARED_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_REPORTED_FILE_BYTES = 1024 * 1024;

export interface ExpectedOutputFilesComparison {
  /** Whether every file under the expected directory has a matching file in the working directory. */
  matches: boolean;
  /** Relative paths (from the working directory) of the files that are missing or different. */
  mismatchedPaths: string[];
  /**
   * `<name>_expected.<ext>` / `<name>_received.<ext>` pairs for each mismatched file, in the
   * format Exercode renders side by side. A received file that is missing, unreadable, not a
   * regular file or larger than `MAX_COMPARED_FILE_BYTES` yields only the expected entry, and a
   * file larger than `MAX_REPORTED_FILE_BYTES` is left out of the pair. Exercode decides per test case whether a learner may see these files.
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
  const expectedFiles = dirents
    .filter((dirent) => dirent.isFile())
    .map((dirent) => ({
      absolutePath: path.join(dirent.parentPath, dirent.name),
      // POSIX separators: `requiredOutputFilePaths` and the result format use them on every platform.
      relativePath: path.posix.join(...path.relative(fileOutputPath, dirent.parentPath).split(path.sep), dirent.name),
    }))
    .toSorted((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  for (const { absolutePath, relativePath } of expectedFiles) {
    // A larger expectation could never be matched by a received file, so it is an authoring error.
    const expectedStats = await fs.promises.stat(absolutePath);
    if (expectedStats.size > MAX_COMPARED_FILE_BYTES) {
      throw new Error(`expected output file ${relativePath} exceeds ${MAX_COMPARED_FILE_BYTES} bytes`);
    }
    const expected = await fs.promises.readFile(absolutePath);
    const received = await readReceivedFile(path.join(cwd, relativePath));
    if (received && fileContentsMatch(expected, received)) continue;

    mismatchedPaths.push(relativePath);
    // A file too large to ship in a result line is left out of the pair rather than truncated.
    if (expected.length <= MAX_REPORTED_FILE_BYTES) {
      outputFiles.push(encodeFileForTestCaseResult(toComparisonPath(relativePath, 'expected'), expected));
    }
    if (received && received.length <= MAX_REPORTED_FILE_BYTES) {
      outputFiles.push(encodeFileForTestCaseResult(toComparisonPath(relativePath, 'received'), received));
    }
  }
  return { matches: mismatchedPaths.length === 0, mismatchedPaths, outputFiles };
}

/**
 * The default verdict of the presets: `.out` decides stdout and `.fout/` decides output files, both
 * checked so a result carries every mismatch; either expectation may be absent. Returns whether the
 * run matched and the output files to report (the plain copies of mismatched required output files
 * replaced by their comparison pairs).
 */
export async function judgeAgainstExpectations(context: {
  stdout: string;
  expectedStdout: string | undefined;
  fileOutputPath: string | undefined;
  cwd: string;
  outputFiles: readonly OutputFile[];
}): Promise<{ matches: boolean; outputFiles: OutputFile[] }> {
  const { stdout, expectedStdout, fileOutputPath, cwd } = context;
  let outputFiles = [...context.outputFiles];
  let matches = expectedStdout === undefined || compareStdoutAsSpaceSeparatedTokens(stdout, expectedStdout);
  if (fileOutputPath !== undefined) {
    const comparison = await compareExpectedOutputFiles(cwd, fileOutputPath);
    if (!comparison.matches) {
      matches = false;
      outputFiles = mergeComparisonOutputFiles(outputFiles, comparison);
    }
  }
  return { matches, outputFiles };
}

/**
 * Replace the plain copies of mismatched required output files with the comparison pairs, so a
 * result shows `<name>_expected.<ext>` / `<name>_received.<ext>` instead of a lone `<name>.<ext>`.
 */
export function mergeComparisonOutputFiles(
  outputFiles: readonly OutputFile[],
  comparison: ExpectedOutputFilesComparison
): OutputFile[] {
  const comparisonPaths = new Set(comparison.outputFiles.map((file) => file.path));
  // The plain copy gives way to its `_received` entry; a mismatch too large for a pair keeps the
  // plain copy, and a kept file literally named like a pair entry would make the path ambiguous.
  const replacedPaths = new Set(
    comparison.mismatchedPaths.filter((filePath) => comparisonPaths.has(toComparisonPath(filePath, 'received')))
  );
  return [
    ...outputFiles.filter((file) => !replacedPaths.has(file.path) && !comparisonPaths.has(file.path)),
    ...comparison.outputFiles,
  ];
}

/** `c.txt` → `c_expected.txt`; `out/c.txt` → `out/c_expected.txt`. */
function toComparisonPath(filePath: string, role: 'expected' | 'received'): string {
  const { dir, name, ext } = path.posix.parse(filePath);
  return path.posix.join(dir, `${name}_${role}${ext}`);
}

// Anything that is not a plain, readable file within the size limit (a directory, a FIFO that would
// block, an unreadable or huge file) counts as "not produced".
async function readReceivedFile(receivedPath: string): Promise<Buffer | undefined> {
  try {
    const stats = await fs.promises.stat(receivedPath);
    if (!stats.isFile() || stats.size > MAX_COMPARED_FILE_BYTES) return undefined;
    return await fs.promises.readFile(receivedPath);
  } catch {
    return undefined;
  }
}

function fileContentsMatch(expected: Buffer, received: Buffer): boolean {
  if (!isTextFile(expected)) return received.equals(expected);
  if (!isTextFile(received)) return false;
  return compareStdoutAsSpaceSeparatedTokens(received.toString('utf8'), expected.toString('utf8'));
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

// Valid UTF-8 without NUL bytes: a binary format that happens to decode (e.g. a PNG chunk) almost
// always contains NUL, while text files containing U+FFFD are still treated as text.
function isTextFile(data: Buffer): boolean {
  if (data.includes(0)) return false;
  try {
    utf8Decoder.decode(data);
    return true;
  } catch {
    return false;
  }
}
