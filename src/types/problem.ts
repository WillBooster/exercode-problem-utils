import { z } from 'zod';

export const problemMarkdownFrontMatterSchema = z.object({
  timeLimitMs: z.number().int().min(0).optional(),
  memoryLimitByte: z.number().int().min(0).optional(),
  requiredRegExpsInCode: z.array(z.string().min(1)).optional(),
  forbiddenRegExpsInCode: z.array(z.string().min(1)).optional(),
  forbiddenTextsInCode: z.array(z.string().min(1)).optional(),
  isManualScoringRequired: z.boolean().optional(),
  requiredEnvironmentVariables: z.array(z.string().min(1)).optional(),
  requiredOutputFilePaths: z.array(z.string().min(1)).optional(),
  requiredSubmissionFilePaths: z.array(z.string().min(1)).optional(),
});

export type ProblemMarkdownFrontMatter = z.infer<typeof problemMarkdownFrontMatterSchema>;
