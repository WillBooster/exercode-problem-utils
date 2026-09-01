import { z } from 'zod';

/**
 * A static-analysis rule on submitted code: either a bare pattern (its regular expression or text
 * is shown to learners on violation) or a pattern with a learner-facing message that replaces it.
 * The message is rendered as one Markdown list item, so it must be a single line.
 */
export const codeRuleSchema = z.union([
  z.string().min(1),
  z.object({
    pattern: z.string().min(1),
    message: z
      .string()
      .min(1)
      .refine((message) => !/[\r\n]/.test(message), 'message must be a single line'),
  }),
]);

export type CodeRule = z.infer<typeof codeRuleSchema>;

export const problemMarkdownFrontMatterSchema = z.object({
  timeLimitMs: z.number().int().min(0).optional(),
  memoryLimitByte: z.number().int().min(0).optional(),
  requiredRegExpsInCode: z.array(codeRuleSchema).optional(),
  forbiddenRegExpsInCode: z.array(codeRuleSchema).optional(),
  forbiddenTextsInCode: z.array(codeRuleSchema).optional(),
  isManualScoringRequired: z.boolean().optional(),
  requiredEnvironmentVariables: z.array(z.string().min(1)).optional(),
  requiredOutputFilePaths: z.array(z.string().min(1)).optional(),
  requiredSubmissionFilePaths: z.array(z.string().min(1)).optional(),
});

export type ProblemMarkdownFrontMatter = z.infer<typeof problemMarkdownFrontMatterSchema>;

export function normalizeCodeRule(rule: CodeRule): { pattern: string; message?: string } {
  return typeof rule === 'string' ? { pattern: rule } : rule;
}
