import path from 'node:path';

import { SHARED_TEST_CASE_ID } from './readTestCases.js';
import { EXAMPLE_TEST_CASE_ID_PATTERN } from './stdioJudgeRules.js';

const TEST_CASES_DIRECTORY_NAME = 'test_cases';
const FILE_INPUT_EXTENSION = '.fin';

/**
 * Select, from the files of a problem directory, the input files that the stdio debug preset hands
 * to the debugged program: every file (of any name) in `test_cases/_shared.fin/` and in the `.fin/`
 * directory of the first example test case, in sorted id order, that has one. The `<id>.in`/`<id>.out`
 * entries directly under `test_cases/`, hidden test cases' `.fin/` files, and every file outside
 * `test_cases/` are never selected, so a client can ship the result (plus `problem.md`) to debug a
 * problem without exposing anything the debug run would not expose anyway.
 *
 * @param problemFilePaths Paths relative to the problem directory, separated by `/`
 *   (e.g. `test_cases/_shared.fin/members.csv` or `./test_cases/_shared.fin/members.csv`).
 * @returns The selected paths, in the given order.
 */
export function selectDebugInputFilePaths(problemFilePaths: readonly string[]): string[] {
  const fileInputTestCaseIds = new Set(
    problemFilePaths.flatMap((filePath) => parseFileInputFilePath(filePath)?.testCaseId ?? [])
  );
  const exampleId = [...fileInputTestCaseIds]
    .toSorted()
    .find((id) => id !== SHARED_TEST_CASE_ID && EXAMPLE_TEST_CASE_ID_PATTERN.test(id));
  return problemFilePaths.filter((filePath) => {
    const id = parseFileInputFilePath(filePath)?.testCaseId;
    return id === SHARED_TEST_CASE_ID || (id !== undefined && id === exampleId);
  });
}

/**
 * Split a problem-relative path of a file in a `test_cases/<id>.fin/` directory into the test case id
 * and the file's path inside that directory, or return `undefined` for any other path.
 */
export function parseFileInputFilePath(
  problemFilePath: string
): { testCaseId: string; pathInFileInput: string } | undefined {
  const [directoryName, entryName, ...rest] = path.posix.normalize(problemFilePath).split('/');
  if (directoryName !== TEST_CASES_DIRECTORY_NAME || !entryName?.endsWith(FILE_INPUT_EXTENSION)) return;
  if (rest.length === 0) return;
  return { testCaseId: entryName.slice(0, -FILE_INPUT_EXTENSION.length), pathInFileInput: rest.join('/') };
}
