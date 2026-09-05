import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  collectProblemDefinitions,
  isDirectory,
  isFile,
  isRegularDirectory,
  isRegularFile,
  reportProblemDefinitionIssues,
} from './fsHelpers.js';
import {
  CONTEST_MATERIAL_FILE_SUFFIX,
  courseFileSchema,
  LEARNING_MATERIAL_ID_REGEX,
  type CourseFile,
} from './schemas.js';
import { validateContestFile } from './validateContest.js';
import { validateMaterialFile, validateSubmissionPeriods, type MaterialValidationOptions } from './validateMaterial.js';
import { formatZodIssues, reportDuplicateIds, type ValidationResult } from './validationResult.js';

export interface CourseValidationOptions {
  /** Problems directory referenced by materials; defaults to the course directory (problems at any depth inside it). */
  problemsDirectoryPath?: string;
}

/** Validates an exercode course directory (course.yaml plus one directory per lecture with material files). */
export async function validateCourseDirectory(
  courseDirectoryPath: string,
  options: CourseValidationOptions = {}
): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const result = { errors, warnings };

  const absoluteDirectoryPath = resolve(courseDirectoryPath);
  // Course discovery does not traverse a symbolic link, so a linked course directory is never imported.
  if (!(await isRegularDirectory(absoluteDirectoryPath))) {
    errors.push(
      (await isDirectory(absoluteDirectoryPath))
        ? `course directory is a symbolic link, which the judge does not traverse: ${courseDirectoryPath}`
        : `course directory not found: ${courseDirectoryPath}`
    );
    return result;
  }
  const courseId = basename(absoluteDirectoryPath);
  if (!LEARNING_MATERIAL_ID_REGEX.test(courseId)) {
    errors.push(`course ID "${courseId}" (directory name) must match ${LEARNING_MATERIAL_ID_REGEX}`);
  }

  const parsedCourseFile = await parseCourseFile(absoluteDirectoryPath, errors);
  const problemsDirectoryPath = options.problemsDirectoryPath ?? absoluteDirectoryPath;
  const availableProblemIds = await collectAvailableProblemIds(absoluteDirectoryPath, options, errors);

  if (!parsedCourseFile) return result;
  const { courseFile, courseFileName } = parsedCourseFile;
  const coursePeriodErrors: string[] = [];
  validateSubmissionPeriods(courseFile, coursePeriodErrors);
  errors.push(...coursePeriodErrors.map((error) => `${courseFileName}: ${error}`));
  // The importer treats a missing `lectures` as an empty list, so a course without lectures imports
  // nothing but is valid.
  const lectures = courseFile.lectures ?? [];
  if (lectures.length === 0) {
    warnings.push(`${courseFileName} declares no lectures, so no materials are imported`);
  }
  reportDuplicateIds(
    lectures.map((lecture) => lecture.id),
    'lecture',
    errors
  );
  for (const lecture of lectures) {
    await validateLectureDirectory(
      absoluteDirectoryPath,
      { courseId, courseSubmissionPeriods: courseFile, problemsDirectoryPath, availableProblemIds },
      lecture.id,
      errors,
      warnings
    );
  }
  await reportOrphanLectureDirectories(
    absoluteDirectoryPath,
    courseFile,
    courseFileName,
    problemsDirectoryPath,
    warnings
  );
  return result;
}

/** Directories not listed as lectures are never imported, so their materials silently disappear. */
async function reportOrphanLectureDirectories(
  courseDirectoryPath: string,
  courseFile: CourseFile,
  courseFileName: string,
  problemsDirectoryPath: string | undefined,
  warnings: string[]
): Promise<void> {
  const lectureIds = new Set((courseFile.lectures ?? []).map((lecture) => lecture.id));
  // The course's own `problems/` holds problems, never lecture materials, whichever problems
  // directory the validation resolved to.
  const problemsDirectoryNames = new Set(['problems']);
  if (problemsDirectoryPath && dirname(resolve(problemsDirectoryPath)) === courseDirectoryPath) {
    problemsDirectoryNames.add(basename(problemsDirectoryPath));
  }
  const dirents = await readdir(courseDirectoryPath, { withFileTypes: true });
  for (const dirent of dirents) {
    if (
      !dirent.isDirectory() ||
      dirent.name.startsWith('.') ||
      lectureIds.has(dirent.name) ||
      problemsDirectoryNames.has(dirent.name)
    )
      continue;
    warnings.push(
      `directory "${dirent.name}" is not listed as a lecture in ${courseFileName}, so its materials are not imported`
    );
  }
}

async function parseCourseFile(
  courseDirectoryPath: string,
  errors: string[]
): Promise<{ courseFile: CourseFile; courseFileName: string } | undefined> {
  // The judge discovers courses by `course.yaml` or `course.yml` (rejecting a directory with both)
  // and skips symbolic links.
  const courseFileNames = ['course.yaml', 'course.yml'];
  const presentFileNames: string[] = [];
  for (const fileName of courseFileNames) {
    if (await isRegularFile(join(courseDirectoryPath, fileName))) presentFileNames.push(fileName);
  }
  if (presentFileNames.length > 1) {
    errors.push('both course.yaml and course.yml exist; the judge rejects the conflicting course files');
    return undefined;
  }
  const courseFileName = presentFileNames[0];
  if (courseFileName === undefined) {
    const symlinkFileName = await findFirst(courseFileNames, (fileName) => isFile(join(courseDirectoryPath, fileName)));
    errors.push(
      symlinkFileName === undefined
        ? 'course.yaml not found'
        : `${symlinkFileName} is a symbolic link, which the judge ignores; commit a regular file`
    );
    return undefined;
  }
  const courseFilePath = join(courseDirectoryPath, courseFileName);
  let rawContent: unknown;
  try {
    rawContent = parseYaml(await readFile(courseFilePath, 'utf8'));
  } catch (error) {
    errors.push(`${courseFileName}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  const parsed = courseFileSchema.safeParse(rawContent);
  if (!parsed.success) {
    errors.push(...formatZodIssues(parsed.error, courseFileName));
    return undefined;
  }
  return { courseFile: parsed.data, courseFileName };
}

async function findFirst<T>(items: readonly T[], predicate: (item: T) => Promise<boolean>): Promise<T | undefined> {
  for (const item of items) {
    if (await predicate(item)) return item;
  }
  return undefined;
}

/**
 * The judge scopes every problem inside the course directory (at any depth) to the course, so the
 * course is always searched; an explicit directory must lie inside it.
 */
async function collectAvailableProblemIds(
  courseDirectoryPath: string,
  options: CourseValidationOptions,
  errors: string[]
): Promise<Set<string>> {
  const definitionPathsById = await collectProblemDefinitions(courseDirectoryPath);
  reportProblemDefinitionIssues(definitionPathsById, errors);
  const availableProblemIds = new Set(definitionPathsById.keys());
  // Discovery does not traverse a symbolic link, so a linked problems directory imports nothing.
  const courseProblemsDirectoryPath = join(courseDirectoryPath, 'problems');
  if (!(await isRegularDirectory(courseProblemsDirectoryPath)) && (await isDirectory(courseProblemsDirectoryPath))) {
    errors.push(
      `problems directory is a symbolic link, which the judge does not traverse: ${courseProblemsDirectoryPath}`
    );
  }
  if (options.problemsDirectoryPath === undefined) return availableProblemIds;
  if (!(await isRegularDirectory(options.problemsDirectoryPath))) {
    errors.push(
      (await isDirectory(options.problemsDirectoryPath))
        ? `problems directory is a symbolic link, which the judge does not traverse: ${options.problemsDirectoryPath}`
        : `problems directory not found: ${options.problemsDirectoryPath}`
    );
  } else if (relative(courseDirectoryPath, resolve(options.problemsDirectoryPath)).startsWith('..')) {
    // Exercode links a material only to problems inside its course, so outside problems never count.
    errors.push(
      `problems directory ${options.problemsDirectoryPath} is outside the course directory; Exercode links a material only to problems inside the course, so move them under the course`
    );
  }
  return availableProblemIds;
}

async function validateLectureDirectory(
  courseDirectoryPath: string,
  materialOptions: MaterialValidationOptions,
  lectureId: string,
  errors: string[],
  warnings: string[]
): Promise<void> {
  const lectureDirectoryPath = join(courseDirectoryPath, lectureId);
  // The judge lists lecture entries as regular files and directories, so symbolic links vanish.
  if (!(await isRegularDirectory(lectureDirectoryPath))) {
    errors.push(
      (await isDirectory(lectureDirectoryPath))
        ? `lecture "${lectureId}": directory is a symbolic link, which the judge does not traverse`
        : `lecture "${lectureId}": directory not found`
    );
    return;
  }

  const materialIds: string[] = [];
  const dirents = await readdir(lectureDirectoryPath, { withFileTypes: true });
  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) {
      errors.push(`${lectureId}/${dirent.name} is a symbolic link, which the judge ignores; commit a regular file`);
    }
  }
  const fileNames = dirents
    .filter((dirent) => dirent.isFile())
    .map((dirent) => dirent.name)
    .toSorted((f1, f2) => f1.localeCompare(f2));
  for (const fileName of fileNames) {
    const materialFilePath = join(lectureDirectoryPath, fileName);
    let materialResult: ValidationResult;
    if (fileName.endsWith(CONTEST_MATERIAL_FILE_SUFFIX)) {
      materialIds.push(fileName.slice(0, -CONTEST_MATERIAL_FILE_SUFFIX.length));
      materialResult = await validateContestFile(materialFilePath, { ...materialOptions, isNestedInCourse: true });
    } else if (fileName.endsWith('.md')) {
      materialIds.push(fileName.replace(/\.[^/.]+$/, ''));
      materialResult = await validateMaterialFile(materialFilePath, materialOptions);
    } else {
      continue;
    }
    errors.push(...materialResult.errors.map((error) => `${lectureId}/${fileName}: ${error}`));
    warnings.push(...materialResult.warnings.map((warning) => `${lectureId}/${fileName}: ${warning}`));
  }

  if (materialIds.length === 0) {
    warnings.push(`lecture "${lectureId}": no material files (*.md or *${CONTEST_MATERIAL_FILE_SUFFIX}) found`);
  }
  // Material IDs only need to be unique per lecture: exercode's import key is
  // `${courseId}.${lectureId}.${materialId}`, so a course-wide check would reject courses
  // that import fine. Scope the report to the lecture so multi-lecture courses point at the
  // right files.
  const duplicateMaterialErrors: string[] = [];
  reportDuplicateIds(materialIds, 'material', duplicateMaterialErrors);
  errors.push(...duplicateMaterialErrors.map((error) => `lecture "${lectureId}": ${error}`));
}
