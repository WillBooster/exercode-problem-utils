import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  collectProblemDefinitions,
  isDirectory,
  isFile,
  isRegularDirectory,
  isRegularFile,
  reportConflictingProblemDefinitions,
} from './fsHelpers.js';
import { CONTEST_MATERIAL_FILE_SUFFIX, contestFileSchema, LEARNING_MATERIAL_ID_REGEX } from './schemas.js';
import {
  mergeSubmissionPeriods,
  reportForeignProblemCourseIds,
  validateSubmissionPeriods,
  type SubmissionPeriods,
} from './validateMaterial.js';
import { formatZodIssues, reportDuplicateIds, type ValidationResult } from './validationResult.js';

export interface ContestValidationOptions {
  /** When set, every contest problem ID must be a problem discovered under this path. */
  problemsDirectoryPath?: string;
  /** Problem IDs already collected for the enclosing course; collected from `problemsDirectoryPath` otherwise. */
  availableProblemIds?: ReadonlySet<string>;
  /** Enclosing course ID; the judge rejects problem references whose `courseId` differs from it. */
  courseId?: string;
  /** Course-level submission periods; the judge merges them as `material[field] ?? course[field]`. */
  courseSubmissionPeriods?: SubmissionPeriods;
  /** Set by course validation, which already warns once about a missing problems directory. */
  isNestedInCourse?: boolean;
}

/** Validates a judge contest material (`*.contest.yaml`) file. */
export async function validateContestFile(
  contestFilePath: string,
  options: ContestValidationOptions = {}
): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const result = { errors, warnings };

  // The judge lists lecture entries as regular files, so a symbolic link is skipped at import time.
  if (!(await isRegularFile(contestFilePath))) {
    errors.push(
      (await isFile(contestFilePath))
        ? `contest file is a symbolic link, which the judge ignores; commit a regular file: ${contestFilePath}`
        : `contest file not found: ${contestFilePath}`
    );
    return result;
  }
  const fileName = basename(contestFilePath);
  if (!fileName.endsWith(CONTEST_MATERIAL_FILE_SUFFIX)) {
    errors.push(`contest file name must end with ${CONTEST_MATERIAL_FILE_SUFFIX}: ${fileName}`);
    return result;
  }
  const contestId = fileName.slice(0, -CONTEST_MATERIAL_FILE_SUFFIX.length);
  if (!LEARNING_MATERIAL_ID_REGEX.test(contestId)) {
    errors.push(
      `contest ID "${contestId}" (file name without ${CONTEST_MATERIAL_FILE_SUFFIX}) must match ${LEARNING_MATERIAL_ID_REGEX}`
    );
  }

  let rawContent: unknown;
  try {
    rawContent = parseYaml(await readFile(contestFilePath, 'utf8'));
  } catch (error) {
    errors.push(`invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
  const parsed = contestFileSchema.safeParse(rawContent);
  if (!parsed.success) {
    errors.push(...formatZodIssues(parsed.error, 'contest'));
    return result;
  }

  validateSubmissionPeriods(mergeSubmissionPeriods(parsed.data, options.courseSubmissionPeriods), errors, parsed.data);
  reportForeignProblemCourseIds(parsed.data.problems, options.courseId, errors);
  reportDuplicateIds(
    parsed.data.divisions.map((division) => division.id),
    'division',
    errors
  );
  reportDuplicateIds(
    parsed.data.problems.map((problem) => problem.id),
    'problem',
    errors
  );

  if (options.problemsDirectoryPath === undefined) {
    if (!options.isNestedInCourse) {
      warnings.push('no problems directory given (pass --problems-dir); problem references are not checked');
    }
  } else if (!(await isRegularDirectory(options.problemsDirectoryPath))) {
    errors.push(
      (await isDirectory(options.problemsDirectoryPath))
        ? `problems directory is a symbolic link, which the judge does not traverse: ${options.problemsDirectoryPath}`
        : `problems directory not found: ${options.problemsDirectoryPath}`
    );
  } else {
    let availableProblemIds = options.availableProblemIds;
    if (availableProblemIds === undefined) {
      const definitionPathsById = await collectProblemDefinitions(options.problemsDirectoryPath);
      reportConflictingProblemDefinitions(definitionPathsById, errors);
      availableProblemIds = new Set(definitionPathsById.keys());
    }
    for (const problem of parsed.data.problems) {
      if (!availableProblemIds.has(problem.id)) {
        errors.push(`problem "${problem.id}" is referenced but does not exist under ${options.problemsDirectoryPath}`);
      }
    }
  }
  return result;
}
