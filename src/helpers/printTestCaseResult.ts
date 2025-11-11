import { DecisionCode } from '../types/decisionCode.js';
import type { TestCaseResult } from '../types/testCaseResult.js';
import { TEST_CASE_RESULT_PREFIX } from '../types/testCaseResult.js';

const defaultTestCaseResult = {
  testCaseId: '',
  decisionCode: DecisionCode.ACCEPTED,
  exitStatus: 0,
  stdin: '',
  stdout: '',
  stderr: '',
  timeSeconds: 0,
  memoryBytes: 0,
  feedbackMarkdown: '',
  outputFiles: [],
} as const satisfies TestCaseResult;

export function printTestCaseResult(result: Pick<TestCaseResult, 'testCaseId'> & Partial<TestCaseResult>): void {
  console.info(`${TEST_CASE_RESULT_PREFIX}${JSON.stringify({ ...defaultTestCaseResult, ...result })}`);
}

export function encodeFileForTestCaseResult(path: string, data: Buffer): TestCaseResult['outputFiles'][number] {
  const utf8Text = data.toString('utf8');
  const isBinary = utf8Text.includes('\uFFFD');
  return isBinary ? { path, encoding: 'base64', data: data.toString('base64') } : { path, data: utf8Text };
}
