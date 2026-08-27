import { z } from 'zod';

export const TEST_CASE_RESULT_PREFIX = 'TEST_CASE_RESULT ';

const testCaseResultOutputFileSchema = z.object({
  path: z.string(),
  data: z.string(),
  encoding: z.literal('base64').optional(),
});

export const testCaseResultSchema = z.object({
  testCaseId: z.string(),
  decisionCode: z.number().int(),
  exitStatus: z.number().int().optional(),
  stdin: z.string().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  timeSeconds: z.number().optional(),
  memoryBytes: z.number().optional(),
  feedbackMarkdown: z.string().optional(),
  /** Numeric score of a model-evaluation submission (e.g. an RMSLE value). */
  score: z.number().optional(),
  /** Label of `score` shown to learners (e.g. `RMSLE`). */
  scoreLabel: z.string().optional(),
  outputFiles: z.array(testCaseResultOutputFileSchema).optional(),
});

export type TestCaseResult = z.infer<typeof testCaseResultSchema>;
