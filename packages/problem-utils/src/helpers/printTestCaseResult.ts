import type { TestCaseResult } from '../types/testCaseResult.js';
import { TEST_CASE_RESULT_PREFIX } from '../types/testCaseResult.js';

/**
 * Print a test case result in a format that can be read by the judge server.
 */
export function printTestCaseResult(result: TestCaseResult): void {
  console.info(`${TEST_CASE_RESULT_PREFIX}${JSON.stringify(result)}`);
}

export function encodeFileForTestCaseResult(
  path: string,
  data: Buffer
): NonNullable<TestCaseResult['outputFiles']>[number] {
  const utf8Text = data.toString('utf8');
  const isBinary = utf8Text.includes('\uFFFD');
  return isBinary ? { path, encoding: 'base64', data: data.toString('base64') } : { path, data: utf8Text };
}
