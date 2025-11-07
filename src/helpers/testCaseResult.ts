import { DecisionCode } from '../types/decisionCode.js';
import type { TestCaseResult } from '../types/testCaseResult.js';

const TEST_CASE_RESULT_PREFIX = 'TEST_CASE_RESULT ';

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
