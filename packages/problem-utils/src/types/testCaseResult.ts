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
  /** Wall time of the run; time limits are judged by it. */
  timeSeconds: z.number().optional(),
  /**
   * User plus system CPU time of the run, summed over its threads and the processes it waited for.
   * A time limit exceeded whose CPU time reaches the limit would be exceeded on any single CPU,
   * while one whose CPU time stays below it may stem from waiting for a CPU shared with other
   * programs.
   */
  cpuTimeSeconds: z.number().optional(),
  memoryBytes: z.number().optional(),
  feedbackMarkdown: z.string().optional(),
  /** Numeric score of a model-evaluation submission (e.g. an RMSLE value). */
  score: z.number().optional(),
  /** Label of `score` shown to learners (e.g. `RMSLE`). */
  scoreLabel: z.string().optional(),
  outputFiles: z.array(testCaseResultOutputFileSchema).optional(),
});

export type TestCaseResult = z.infer<typeof testCaseResultSchema>;
