import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseFrontmatter } from './frontmatter.js';
import { isFile } from './fsHelpers.js';
import {
  LEARNING_MATERIAL_ID_REGEX,
  materialFrontmatterSchema,
  questionInCodeBlockSchema,
  type MaterialQuestion,
} from './schemas.js';
import { formatZodIssues, reportDuplicateIds, type ValidationResult } from './validationResult.js';

// Same patterns the judge uses to extract embedded questions and problem links from material bodies.
// The block regex intentionally requires LF line endings and a trailing newline after the closing
// fence, exactly like the judge parser; blocks it misses are reported by detecting leftover openers.
const QUESTION_CODE_BLOCK_REGEX = /(?:^|\n)(?<fence>`{3,}|~{3,})ya?ml +question\n(?<yaml>[\s\S]+?)\n\k<fence>\n/g;
// Strictly laxer than the parser regex (tolerates CRLF, indentation, and stray whitespace) so
// question-looking blocks the judge parser would silently skip surface as leftover openers.
const QUESTION_CODE_BLOCK_OPENER_REGEX = /^[ \t]*(?:`{3,}|~{3,})[ \t]*ya?ml[ \t]+question[ \t]*\r?$/gm;
const PROBLEM_LINK_REGEX = /\[.*?]\(problems\/([0-9_a-z-]+?)\)/g;
const TURTLE_GRAPHICS_QUESTION_LINK_REGEX = /\[.*?]\(turtle-graphics-questions\/([0-9_a-z-]+?)\)/g;
const CHAT_MARKER = '<!-- chat -->';
// exercode only counts the marker when it stands alone on a line, so fenced or inline mentions don't count.
const STANDALONE_CHAT_MARKER_REGEX = /(^|\r?\n)<!-- chat -->[ \t]*(?=\r?\n|$)/g;

export interface SubmissionPeriods {
  submissionOpenedAt?: string;
  submissionSoftClosedAt?: string;
  submissionHardClosedAt?: string;
}

export interface MaterialValidationOptions {
  /** When set, every referenced problem ID must resolve to a directory under this path. */
  problemsDirectoryPath?: string;
  /** Enclosing course ID; the judge rejects problem references whose `courseId` differs from it. */
  courseId?: string;
  /** Course-level submission periods; the judge merges them as `material[field] ?? course[field]`. */
  courseSubmissionPeriods?: SubmissionPeriods;
}

/** Validates an exercode markdown material file (frontmatter, embedded questions, problem references). */
export async function validateMaterialFile(
  materialFilePath: string,
  options: MaterialValidationOptions = {}
): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const result = { errors, warnings };

  const materialId = basename(materialFilePath).replace(/\.[^/.]+$/, '');
  if (!LEARNING_MATERIAL_ID_REGEX.test(materialId)) {
    errors.push(`material ID "${materialId}" (file name without extension) must match ${LEARNING_MATERIAL_ID_REGEX}`);
  }

  let markdown: string;
  try {
    markdown = await readFile(materialFilePath, 'utf8');
  } catch {
    errors.push(`material file not found: ${materialFilePath}`);
    return result;
  }

  let attributes: unknown;
  let body: string;
  try {
    ({ attributes, body } = parseFrontmatter(markdown));
  } catch (error) {
    errors.push(`invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }

  const parsedFrontmatter = materialFrontmatterSchema.safeParse(attributes);
  if (!parsedFrontmatter.success) {
    errors.push(...formatZodIssues(parsedFrontmatter.error, 'frontmatter'));
  }
  const frontmatter = parsedFrontmatter.success ? parsedFrontmatter.data : undefined;

  const questions = [...(frontmatter?.questions ?? []), ...parseQuestionCodeBlocks(body, errors)];
  for (const question of questions) {
    validateQuestion(question, errors);
  }
  reportDuplicateIds(
    questions.map((question) => question.id),
    'question',
    errors
  );
  // Turtle-graphics links in the body merge into the frontmatter list like problem links do,
  // and exercode rejects duplicates in the merged list; deferred until after the question blocks
  // are removed below so links inside question text don't count.

  // The judge deduplicates the links it collects from the body, then merges them with the
  // frontmatter list without deduplication, so a problem listed twice in the frontmatter or listed
  // there and linked in the body is a duplicate reference while linking it twice in prose is not.
  // The judge replaces recognized question blocks with @[question](id) links before collecting
  // links, so links that appear only inside question text must not count here either.
  const bodyWithoutQuestionBlocks = body.replaceAll(QUESTION_CODE_BLOCK_REGEX, '\n');
  reportDuplicateIds(
    [
      ...(frontmatter?.turtleGraphicsQuestions ?? []).map((question) => question.id),
      ...collectLinkedIds(bodyWithoutQuestionBlocks, TURTLE_GRAPHICS_QUESTION_LINK_REGEX),
    ],
    'turtleGraphicsQuestion',
    errors
  );
  const problemIds = [
    ...(frontmatter?.problems ?? []).map((problem) => problem.id),
    ...collectLinkedIds(bodyWithoutQuestionBlocks, PROBLEM_LINK_REGEX),
  ];
  reportDuplicateIds(problemIds, 'problem', errors);
  reportForeignProblemCourseIds(frontmatter?.problems ?? [], options.courseId, errors);
  if (options.problemsDirectoryPath !== undefined) {
    for (const problemId of new Set(problemIds)) {
      if (!(await problemDefinitionExists(options.problemsDirectoryPath, problemId))) {
        errors.push(`problem "${problemId}" is referenced but does not exist under ${options.problemsDirectoryPath}`);
      }
    }
  }

  reportExcessChatMarkers(body, errors);

  if (frontmatter) {
    validateSubmissionPeriods(
      mergeSubmissionPeriods(frontmatter, options.courseSubmissionPeriods),
      errors,
      frontmatter
    );
  }
  return result;
}

function collectLinkedIds(body: string, linkRegex: RegExp): string[] {
  return [...new Set([...body.matchAll(linkRegex)].map((match) => match[1]).filter((id) => id !== undefined))];
}

/** Applies the judge's course→material config merge (`material[field] ?? course[field]`). */
export function mergeSubmissionPeriods(
  own: SubmissionPeriods,
  courseDefaults: SubmissionPeriods | undefined
): SubmissionPeriods {
  return {
    submissionOpenedAt: own.submissionOpenedAt ?? courseDefaults?.submissionOpenedAt,
    submissionSoftClosedAt: own.submissionSoftClosedAt ?? courseDefaults?.submissionSoftClosedAt,
    submissionHardClosedAt: own.submissionHardClosedAt ?? courseDefaults?.submissionHardClosedAt,
  };
}

/**
 * The judge discovers problems by globbing for `problem.md` (v2) or `<id>.problem.md` (v1) files,
 * so a bare directory without a statement file is not a problem and references to it are dangling.
 */
export async function problemDefinitionExists(problemsDirectoryPath: string, problemId: string): Promise<boolean> {
  return (
    (await isFile(join(problemsDirectoryPath, problemId, 'problem.md'))) ||
    (await isFile(join(problemsDirectoryPath, problemId, `${problemId}.problem.md`))) ||
    (await isFile(join(problemsDirectoryPath, `${problemId}.problem.md`)))
  );
}

/** exercode rejects more than one standalone chat delimiter line in material and problem bodies. */
export function reportExcessChatMarkers(body: string, errors: string[]): void {
  const chatMarkerCount = [...body.matchAll(STANDALONE_CHAT_MARKER_REGEX)].length;
  if (chatMarkerCount > 1) {
    errors.push(`at most one \`${CHAT_MARKER}\` marker is allowed, but found ${chatMarkerCount}`);
  }
}

/** The judge's resolveProblemCourseId throws when a problem reference names a different course. */
export function reportForeignProblemCourseIds(
  problems: readonly { id: string; courseId?: string }[],
  courseId: string | undefined,
  errors: string[]
): void {
  if (courseId === undefined) return;
  for (const problem of problems) {
    if (problem.courseId !== undefined && problem.courseId !== courseId) {
      errors.push(`problem "${problem.id}": courseId must be "${courseId}" but is "${problem.courseId}"`);
    }
  }
}

function parseQuestionCodeBlocks(body: string, errors: string[]): MaterialQuestion[] {
  const questions: MaterialQuestion[] = [];
  const matches = [...body.matchAll(QUESTION_CODE_BLOCK_REGEX)];
  // The judge silently renders unparsed question blocks as plain code blocks, so a block the
  // strict regex misses (CRLF line endings, or no newline after the closing fence) would break
  // in production while looking fine here; flag it instead of validating a li.e.
  const openerCount = [...body.matchAll(QUESTION_CODE_BLOCK_OPENER_REGEX)].length;
  if (openerCount > matches.length) {
    errors.push(
      `${openerCount - matches.length} question code block(s) will not be recognized by the judge parser; separate consecutive question blocks with a blank line, use LF line endings, no indentation or trailing whitespace on the fence line, and end the closing fence with a newline`
    );
  }
  for (const [blockIndex, match] of matches.entries()) {
    const yamlText = match.groups?.['yaml'] ?? '';
    let rawQuestion: unknown;
    try {
      rawQuestion = parseYaml(yamlText);
    } catch (error) {
      errors.push(
        `question block ${blockIndex + 1}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    const parsed = questionInCodeBlockSchema.safeParse(rawQuestion);
    if (parsed.success) {
      questions.push(parsed.data);
    } else {
      errors.push(...formatZodIssues(parsed.error, `question block ${blockIndex + 1}`));
    }
  }
  return questions;
}

function validateQuestion(question: MaterialQuestion, errors: string[]): void {
  const isSurvey = question.isSurvey === true;
  const [answerFieldName, isAnswerDefined] =
    question.type === 'select'
      ? (['answerIndex', question.answerIndex !== undefined] as const)
      : question.type === 'select_multiple'
        ? (['answerIndices', question.answerIndices !== undefined] as const)
        : (['answerPattern', question.answerPattern !== undefined] as const);
  if (isSurvey && isAnswerDefined) {
    errors.push(`question ${question.id}: \`${answerFieldName}\` must not be set when \`isSurvey\` is true`);
  }
  if (!isSurvey && !isAnswerDefined) {
    errors.push(`question ${question.id}: \`${answerFieldName}\` is required when \`isSurvey\` is not true`);
  }

  if (question.type === 'select' || question.type === 'select_multiple') {
    const answerIndices =
      question.type === 'select'
        ? Array.isArray(question.answerIndex)
          ? question.answerIndex
          : question.answerIndex === undefined
            ? []
            : [question.answerIndex]
        : (question.answerIndices ?? []);
    // An empty answer set is broken at runtime (select: never correct; select_multiple: an empty
    // submission grades as correct), and exercode's material editor rejects it as well.
    if (!isSurvey && isAnswerDefined && answerIndices.length === 0) {
      errors.push(`question ${question.id}: \`${answerFieldName}\` must contain at least one correct answer`);
    }
    for (const answerIndex of answerIndices) {
      if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= question.options.length) {
        errors.push(
          `question ${question.id}: ${answerFieldName} out of bounds: ${answerIndex}; expected 0 <= index < options length ${question.options.length}`
        );
      }
    }
    return;
  }

  if (isSurvey || question.answerPattern === undefined) return;
  const answerPattern = question.answerPattern.trim();
  let answerRegExp: RegExp;
  let rawAnswerRegExp: RegExp;
  try {
    answerRegExp = new RegExp(`^(?:${answerPattern})$`);
    // Compiled inside the same guard: a pattern like `a)(b` is valid only once wrapped above,
    // so an unguarded raw compile would crash the CLI instead of reporting an error.
    rawAnswerRegExp = new RegExp(question.answerPattern);
  } catch {
    errors.push(
      `question ${question.id}: \`answerPattern\` is not a valid regular expression: ${question.answerPattern}`
    );
    return;
  }
  // Mirrors the judge heuristic: a pattern that doesn't match itself likely uses RegExp syntax,
  // so a modelAnswer is required to prove that some concrete answer is accepted.
  // Like the judge, an empty modelAnswer counts as missing.
  // The judge runs this heuristic on the untrimmed pattern and trims only for the anchored match.
  if (!question.modelAnswer && !rawAnswerRegExp.test(question.answerPattern)) {
    errors.push(`question ${question.id}: \`answerPattern\` seems a RegExp but \`modelAnswer\` is missing`);
  }
  if (question.modelAnswer && !answerRegExp.test(question.modelAnswer.trim())) {
    errors.push(`question ${question.id}: \`modelAnswer\` doesn't match \`answerPattern\``);
  }
}

/**
 * Reports inverted submission periods; shared by material, course.yaml, and contest validation.
 * When `ownPeriods` is given (the merged-values case), pairs whose both values are inherited from
 * the course are skipped: they are the course's mistake and are already reported against
 * course.yaml, so repeating them per material would send agents to files with nothing to fix.
 */
export function validateSubmissionPeriods(
  periods: SubmissionPeriods,
  errors: string[],
  ownPeriods: SubmissionPeriods = periods
): void {
  const pairs = [
    ['submissionOpenedAt', 'submissionSoftClosedAt'],
    ['submissionSoftClosedAt', 'submissionHardClosedAt'],
    ['submissionOpenedAt', 'submissionHardClosedAt'],
  ] as const satisfies readonly (readonly [keyof SubmissionPeriods, keyof SubmissionPeriods])[];
  for (const [earlierName, laterName] of pairs) {
    const earlierValue = periods[earlierName];
    const laterValue = periods[laterName];
    if (earlierValue === undefined || laterValue === undefined) continue;
    if (ownPeriods[earlierName] === undefined && ownPeriods[laterName] === undefined) continue;
    if (new Date(laterValue).getTime() < new Date(earlierValue).getTime()) {
      errors.push(`${earlierName} (${earlierValue}) must be <= ${laterName} (${laterValue})`);
    }
  }
}
