import { SHARED_TEST_CASE_ID } from './readTestCases.js';
import { EXAMPLE_TEST_CASE_ID_PATTERN } from './stdioJudgeRules.js';

const TEST_CASES_DIRECTORY_NAME = 'test_cases';
const FILE_INPUT_EXTENSION = '.fin';

/**
 * Select, from the files of a problem directory, the input files that the stdio debug preset hands
 * to the debugged program: those in `test_cases/_shared.fin/` and in the `.fin/` directory of the
 * first example test case that has one. Hidden test cases' files, `.in`/`.out` files, and every file
 * outside `test_cases/` are never selected, so a client can ship the result (plus `problem.md`) to
 * debug a problem without exposing anything the debug run would not expose anyway.
 *
 * @param problemFilePaths Paths relative to the problem directory, separated by `/`
 *   (e.g. `test_cases/_shared.fin/members.csv`).
 * @returns The selected paths, in the given order.
 */
export function selectDebugInputFilePaths(problemFilePaths: readonly string[]): string[] {
  const pathToTestCaseId = new Map<string, string>();
  for (const filePath of problemFilePaths) {
    const [directoryName, entryName, ...rest] = filePath.split('/');
    if (directoryName !== TEST_CASES_DIRECTORY_NAME || !entryName?.endsWith(FILE_INPUT_EXTENSION)) continue;
    if (rest.length === 0) continue;
    pathToTestCaseId.set(filePath, entryName.slice(0, -FILE_INPUT_EXTENSION.length));
  }
  const selectedIds = new Set(selectDebugFileInputTestCaseIds(pathToTestCaseId.values()));
  return problemFilePaths.filter((filePath) => {
    const id = pathToTestCaseId.get(filePath);
    return id !== undefined && selectedIds.has(id);
  });
}

/**
 * The ids of the `test_cases/<id>.fin/` directories a debug run receives, in the order they are copied
 * (later ones overwrite earlier ones), given the ids of every such directory (`_shared` included).
 */
export function selectDebugFileInputTestCaseIds(fileInputTestCaseIds: Iterable<string>): string[] {
  const ids = [...new Set(fileInputTestCaseIds)].toSorted();
  const sharedIds = ids.filter((id) => id === SHARED_TEST_CASE_ID);
  const exampleId = ids.find((id) => id !== SHARED_TEST_CASE_ID && EXAMPLE_TEST_CASE_ID_PATTERN.test(id));
  return exampleId === undefined ? sharedIds : [...sharedIds, exampleId];
}
