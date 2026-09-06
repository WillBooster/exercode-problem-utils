import { validateContestFile } from '../learningMaterial/validateContest.js';
import { validateCourseDirectory } from '../learningMaterial/validateCourse.js';
import { validateProblemDirectory } from '../learningMaterial/validateProblem.js';
import { formatValidationReport, type ValidationResult } from '../learningMaterial/validationResult.js';

export const VALIDATE_SUBCOMMANDS = ['validate-problem', 'validate-course', 'validate-contest'] as const;

export type ValidateSubcommand = (typeof VALIDATE_SUBCOMMANDS)[number];

/**
 * Validate learning-material files without running any program and print one report per target.
 * Returns the process exit code: 1 when any target has an error (warnings alone pass).
 */
export async function validateLearningMaterial(
  subcommand: ValidateSubcommand,
  args: readonly string[]
): Promise<number> {
  const { targets, problemsDir } = parseValidateArgs(args);
  if (targets.length === 0) throw new Error(`${subcommand} requires at least one path`);
  if (subcommand === 'validate-problem') {
    if (problemsDir !== undefined) throw new Error(`${subcommand} does not take --problems-dir`);
  } else if (targets.length > 1) {
    throw new Error(`${subcommand} accepts exactly one path, but got ${targets.length}`);
  }

  let hasError = false;
  for (const target of targets) {
    const result = await validate(subcommand, target, problemsDir);
    process.stdout.write(formatValidationReport(target, result));
    hasError ||= result.errors.length > 0;
  }
  return hasError ? 1 : 0;
}

async function validate(
  subcommand: ValidateSubcommand,
  target: string,
  problemsDirectoryPath: string | undefined
): Promise<ValidationResult> {
  switch (subcommand) {
    case 'validate-problem': {
      return validateProblemDirectory(target);
    }
    case 'validate-course': {
      return validateCourseDirectory(target, { problemsDirectoryPath });
    }
    case 'validate-contest': {
      return validateContestFile(target, { problemsDirectoryPath });
    }
  }
}

function parseValidateArgs(args: readonly string[]): { targets: string[]; problemsDir: string | undefined } {
  const targets: string[] = [];
  let problemsDir: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) break;
    if (arg === '--problems-dir') {
      problemsDir = args[++index];
      if (problemsDir === undefined) throw new Error(`${arg} requires a value`);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      targets.push(arg);
    }
  }
  return { targets, problemsDir };
}
