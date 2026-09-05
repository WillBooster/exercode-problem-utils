import { z } from 'zod';

import { languageIdToDefinition } from '../types/language.js';
import { codeRuleSchema } from '../types/problem.js';

// Schemas in this file mirror the Exercode judge importer so that generated materials validate
// exactly like the importer would parse them.

export const LEARNING_MATERIAL_ID_REGEX = /^[0-9_a-z-]+$/;

export const learningMaterialIdSchema = z.string().regex(LEARNING_MATERIAL_ID_REGEX);

export const availableLanguageIds = Object.keys(languageIdToDefinition);
const availableLanguageIdSchema = z.enum(availableLanguageIds);

const environmentVariableNameSchema = z.string().regex(/^\w+$/);

// Mirrors the judge server's strict problem frontmatter schema; keys the server removed with the
// v1 judge (judgeEnvironmentId, generalJudgeEnvironmentConfigOverrides, testCases, isGui) are
// rejected here as unknown keys as well.
export const problemFrontmatterSchema = z.strictObject({
  name: z.string().min(1),
  type: z.enum(['prompt_study']).optional(),
  timeLimitMs: z.number().int().min(0).optional(),
  memoryLimitByte: z.number().int().min(0).optional(),
  requiredRegExpsInCode: codeRuleSchema.array().default([]),
  forbiddenRegExpsInCode: codeRuleSchema.array().default([]),
  forbiddenTextsInCode: codeRuleSchema.array().default([]),
  canCreateFiles: z.boolean().optional(),
  isEditorDisabled: z.boolean().optional(),
  isAttachedFileRequired: z.boolean().optional(),
  isManualScoringRequired: z.boolean().optional(),
  isVotable: z.boolean().optional(),
  requiredEnvironmentVariables: z.array(environmentVariableNameSchema).default([]),
  requiredOutputFilePaths: z.string().min(1).array().default([]),
  requiredSubmissionFilePaths: z.string().min(1).array().default([]),
});

export type ProblemFrontmatter = z.infer<typeof problemFrontmatterSchema>;

const materialConfigShape = {
  availableLanguageIds: availableLanguageIdSchema.array().optional(),
  areTestCasesHidden: z.boolean().optional(),
  isProblemGradingResultHidden: z.boolean().optional(),
  isAutoFormatDisabled: z.boolean().optional(),
  isCopyAndPasteDisabled: z.boolean().optional(),
  isDebugHintDisabled: z.boolean().optional(),
  isFixHintDisabled: z.boolean().optional(),
  isDiffHintDisabled: z.boolean().optional(),
  debugHintWaitingSeconds: z.number().min(0).optional(),
  fixHintWaitingSeconds: z.number().min(0).optional(),
  diffHintWaitingSeconds: z.number().min(0).optional(),
  // z.iso.datetime is the zod v4 API (this repo pins zod 4); z.string().datetime is the v3 form.
  submissionOpenedAt: z.iso.datetime({ offset: true }).optional(),
  submissionSoftClosedAt: z.iso.datetime({ offset: true }).optional(),
  submissionHardClosedAt: z.iso.datetime({ offset: true }).optional(),
  isAutoTranslationDisabled: z.boolean().optional(),
  isModelAnswerShownAfterDeadline: z.boolean().optional(),
  isVotable: z.boolean().optional(),
  isMaterialChatDisabled: z.boolean().optional(),
} as const;

export const courseFileSchema = z.strictObject({
  ...materialConfigShape,
  name: z.string().min(1),
  description: z.string(),
  author: z.string().min(1).optional(),
  isMotivationFeatureEnabled: z.boolean().optional(),
  isPublic: z.boolean().optional(),
  lectures: z
    .array(
      z.strictObject({
        id: learningMaterialIdSchema,
        name: z.string().min(1),
        description: z.string(),
      })
    )
    .min(1),
});

export type CourseFile = z.infer<typeof courseFileSchema>;

const uniqueOptionsSchema = z
  .string()
  .array()
  .min(1)
  .refine((options) => options.length === new Set(options).size, { error: 'options must contain unique values' });

const questionBaseShape = {
  id: learningMaterialIdSchema,
  isResubmittable: z.boolean().optional(),
  isSurvey: z.boolean().optional(),
  explanation: z.string().optional(),
  hint: z.string().optional(),
} as const;

const selectQuestionShape = {
  ...questionBaseShape,
  type: z.literal('select'),
  options: uniqueOptionsSchema,
  answerIndex: z
    .union([
      z.number().int().nonnegative(),
      z.string().transform(Number),
      z.number().int().nonnegative().array(),
      z
        .string()
        .array()
        .transform((values) => values.map(Number)),
    ])
    .optional(),
} as const;

const selectMultipleQuestionShape = {
  ...questionBaseShape,
  type: z.literal('select_multiple'),
  options: uniqueOptionsSchema,
  answerIndices: z
    .union([
      z.number().int().nonnegative().array(),
      z
        .string()
        .array()
        .transform((values) => values.map(Number)),
    ])
    .optional(),
} as const;

const textQuestionShape = {
  ...questionBaseShape,
  type: z.literal('text'),
  answerPattern: z.string().min(1).optional(),
  modelAnswer: z.string().optional(),
} as const;

export const questionInCodeBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...selectQuestionShape, question: z.string() }),
  z.strictObject({ ...selectMultipleQuestionShape, question: z.string() }),
  z.strictObject({ ...textQuestionShape, question: z.string() }),
]);

// The judge still supports question definitions in material frontmatter where `question` is optional.
const questionInFrontmatterSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...selectQuestionShape, question: z.string().optional() }),
  z.strictObject({ ...selectMultipleQuestionShape, question: z.string().optional() }),
  z.strictObject({ ...textQuestionShape, question: z.string().optional() }),
]);

export type MaterialQuestion = z.infer<typeof questionInFrontmatterSchema>;

export const materialFrontmatterSchema = z.strictObject({
  ...materialConfigShape,
  name: z.string().min(1),
  problems: z
    .object({ id: learningMaterialIdSchema, courseId: learningMaterialIdSchema.optional() })
    .array()
    .optional(),
  questions: z.array(questionInFrontmatterSchema).optional(),
  turtleGraphicsQuestions: z.object({ id: learningMaterialIdSchema }).array().optional(),
  isExamination: z.boolean().optional(),
  isMockExamination: z.boolean().optional(),
  isRealtimeSurvey: z.boolean().optional(),
});

export type MaterialFrontmatter = z.infer<typeof materialFrontmatterSchema>;

export const CONTEST_MATERIAL_FILE_SUFFIX = '.contest.yaml';

const contestDivisionSchema = z
  .strictObject({
    id: learningMaterialIdSchema,
    name: z.string().min(1),
    openedAt: z.iso.datetime({ offset: true }),
    closedAt: z.iso.datetime({ offset: true }),
    password: z.string().min(1).optional(),
  })
  .refine((division) => new Date(division.openedAt) < new Date(division.closedAt), {
    error: 'openedAt must be earlier than closedAt',
  });

const contestProblemSchema = z.strictObject({
  id: learningMaterialIdSchema,
  score: z.number().int().nonnegative(),
  courseId: learningMaterialIdSchema.optional(),
  // Per-problem overrides reuse the shared material-config fields, mirroring the judge schema.
  areTestCasesHidden: materialConfigShape.areTestCasesHidden,
  isDebugHintDisabled: materialConfigShape.isDebugHintDisabled,
  isFixHintDisabled: materialConfigShape.isFixHintDisabled,
  isDiffHintDisabled: materialConfigShape.isDiffHintDisabled,
  debugHintWaitingSeconds: materialConfigShape.debugHintWaitingSeconds,
  fixHintWaitingSeconds: materialConfigShape.fixHintWaitingSeconds,
  diffHintWaitingSeconds: materialConfigShape.diffHintWaitingSeconds,
  isMaterialChatDisabled: materialConfigShape.isMaterialChatDisabled,
});

export const contestFileSchema = z.strictObject({
  ...materialConfigShape,
  name: z.string().min(1),
  description: z.string().optional(),
  showsProblemsAfterClose: z.boolean().optional(),
  divisions: z.array(contestDivisionSchema).min(1),
  problems: z.array(contestProblemSchema).min(1),
});

export type ContestFile = z.infer<typeof contestFileSchema>;
