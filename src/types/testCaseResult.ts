import { z } from 'zod';

export const TEST_CASE_RESULT_PREFIX = 'TEST_CASE_RESULT ';

const fileSchema = z.object({
  path: z.string(),
  data: z.string(),
  encoding: z.literal('base64').optional(),
});

export const testCaseResultSchema = z.object({
  testCaseId: z.string(),
  decisionCode: z.number().int(),
  exitStatus: z.number().int(),
  stdin: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  timeSeconds: z.number(),
  memoryBytes: z.number(),
  feedbackMarkdown: z.string(),
  outputFiles: z.array(fileSchema),
});

export type TestCaseResult = z.infer<typeof testCaseResultSchema>;
