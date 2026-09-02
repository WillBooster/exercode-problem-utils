import fs from 'node:fs';
import path from 'node:path';

import type { TestCaseResult } from '../types/testCaseResult.js';

import { compareStdoutAsSpaceSeparatedTokens } from './compareStdoutAsSpaceSeparatedTokens.js';
import { encodeFileForTestCaseResult } from './printTestCaseResult.js';
import { isSafeSubmissionOutputPath } from './readOutputFiles.js';

type OutputFile = NonNullable<TestCaseResult['outputFiles']>[number];

// A submission controls the received files, so bound what the trusted harness reads and reports.
const MIN_RECEIVED_FILE_BYTES_LIMIT = 1024 * 1024;

export interface ExpectedOutputFilesComparison {
  /** Whether every file under the expected directory has a matching file in the working directory. */
  matches: boolean;
  /** Relative paths (from the working directory) of the files that are missing or different. */
  mismatchedPaths: string[];
  /**
   * `<name>_expected.<ext>` / `<name>_received.<ext>` pairs for each mismatched file, in the
   * format Exercode renders side by side. A missing or unreadable received file yields only the
   * expected entry. Exercode decides per test case whether a learner may see these files.
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
  const usedPaths = new Set<string>();
  const dirents = await fs.promises.readdir(fileOutputPath, { withFileTypes: true, recursive: true });
  for (const dirent of dirents.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!dirent.isFile()) continue;

    const relativePath = path.join(path.relative(fileOutputPath, dirent.parentPath), dirent.name);
    const expected = await fs.promises.readFile(path.join(dirent.parentPath, dirent.name));
    const received = await readReceivedFile(cwd, path.join(cwd, relativePath), expected.length);
    if (received && fileContentsMatch(expected, received)) continue;

    mismatchedPaths.push(relativePath);
    // A `.fout/` file literally named `<name>_received.<ext>` would otherwise collide with a pair entry.
    const expectedPath = toComparisonPath(relativePath, 'expected');
    if (!usedPaths.has(expectedPath)) outputFiles.push(encodeFileForTestCaseResult(expectedPath, expected));
    usedPaths.add(expectedPath);
    const receivedPath = toComparisonPath(relativePath, 'received');
    if (received && !usedPaths.has(receivedPath)) {
      outputFiles.push(encodeFileForTestCaseResult(receivedPath, received));
    }
    usedPaths.add(receivedPath);
  }
  return { matches: mismatchedPaths.length === 0, mismatchedPaths, outputFiles };
}

/**
 * Replace the plain copies of mismatched required output files with the comparison pairs, so a
 * result shows `<name>_expected.<ext>` / `<name>_received.<ext>` instead of a lone `<name>.<ext>`.
 */
export function mergeComparisonOutputFiles(
  outputFiles: readonly OutputFile[],
  comparison: ExpectedOutputFilesComparison
): OutputFile[] {
  return [...outputFiles.filter((file) => !comparison.mismatchedPaths.includes(file.path)), ...comparison.outputFiles];
}

/** `c.txt` → `c_expected.txt`; `out/c.txt` → `out/c_expected.txt`. */
export function toComparisonPath(filePath: string, role: 'expected' | 'received'): string {
  const { dir, name, ext } = path.parse(filePath);
  return path.join(dir, `${name}_${role}${ext}`);
}

async function readReceivedFile(
  cwd: string,
  receivedPath: string,
  expectedLength: number
): Promise<Buffer | undefined> {
  // A submission-planted symlink to the expected file itself would otherwise compare equal.
  if (!(await isSafeSubmissionOutputPath(cwd, receivedPath))) return undefined;
  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(receivedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  // A file far larger than its expectation cannot match; skip reading it into memory at all.
  if (stats.size > Math.max(MIN_RECEIVED_FILE_BYTES_LIMIT, expectedLength * 4)) return undefined;
  return await fs.promises.readFile(receivedPath);
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
