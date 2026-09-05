import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { isDirectory, isFile } from './fsHelpers.js';
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
  /** Problems directory referenced by materials; defaults to `problems` inside the course, then its legacy sibling. */
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
  if (!(await isDirectory(absoluteDirectoryPath))) {
    errors.push(`course directory not found: ${courseDirectoryPath}`);
    return result;
  }
  const courseId = basename(absoluteDirectoryPath);
  if (!LEARNING_MATERIAL_ID_REGEX.test(courseId)) {
    errors.push(`course ID "${courseId}" (directory name) must match ${LEARNING_MATERIAL_ID_REGEX}`);
  }

  const courseFile = await parseCourseFile(absoluteDirectoryPath, errors);
  const problemsDirectoryPath = await resolveProblemsDirectoryPath(absoluteDirectoryPath, options, errors, warnings);

  if (!courseFile) return result;
  const coursePeriodErrors: string[] = [];
  validateSubmissionPeriods(courseFile, coursePeriodErrors);
  errors.push(...coursePeriodErrors.map((error) => `course.yaml: ${error}`));
  reportDuplicateIds(
    courseFile.lectures.map((lecture) => lecture.id),
    'lecture',
    errors
  );
  for (const lecture of courseFile.lectures) {
    await validateLectureDirectory(
      absoluteDirectoryPath,
      { courseId, courseSubmissionPeriods: courseFile, problemsDirectoryPath },
      lecture.id,
      errors,
      warnings
    );
  }
  await reportOrphanLectureDirectories(absoluteDirectoryPath, courseFile, problemsDirectoryPath, warnings);
  return result;
}

/** Directories not listed as lectures are never imported, so their materials silently disappear. */
async function reportOrphanLectureDirectories(
  courseDirectoryPath: string,
  courseFile: CourseFile,
  problemsDirectoryPath: string | undefined,
  warnings: string[]
): Promise<void> {
  const lectureIds = new Set(courseFile.lectures.map((lecture) => lecture.id));
  const courseProblemsDirectoryName =
    problemsDirectoryPath && dirname(resolve(problemsDirectoryPath)) === courseDirectoryPath
      ? basename(problemsDirectoryPath)
      : undefined;
  const dirents = await readdir(courseDirectoryPath, { withFileTypes: true });
  for (const dirent of dirents) {
    if (
      !dirent.isDirectory() ||
      dirent.name.startsWith('.') ||
      lectureIds.has(dirent.name) ||
      dirent.name === courseProblemsDirectoryName
    )
      continue;
    warnings.push(
      `directory "${dirent.name}" is not listed as a lecture in course.yaml, so its materials are not imported`
    );
  }
}

async function parseCourseFile(courseDirectoryPath: string, errors: string[]): Promise<CourseFile | undefined> {
  const courseFilePath = join(courseDirectoryPath, 'course.yaml');
  if (!(await isFile(courseFilePath))) {
    errors.push('course.yaml not found');
    return undefined;
  }
  let rawContent: unknown;
  try {
    rawContent = parseYaml(await readFile(courseFilePath, 'utf8'));
  } catch (error) {
    errors.push(`course.yaml: invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  const parsed = courseFileSchema.safeParse(rawContent);
  if (!parsed.success) {
    errors.push(...formatZodIssues(parsed.error, 'course.yaml'));
    return undefined;
  }
  return parsed.data;
}

async function resolveProblemsDirectoryPath(
  courseDirectoryPath: string,
  options: CourseValidationOptions,
  errors: string[],
  warnings: string[]
): Promise<string | undefined> {
  if (options.problemsDirectoryPath !== undefined) {
    if (!(await isDirectory(options.problemsDirectoryPath))) {
      errors.push(`problems directory not found: ${options.problemsDirectoryPath}`);
      return undefined;
    }
    return options.problemsDirectoryPath;
  }
  const courseProblemsDirectoryPath = join(courseDirectoryPath, 'problems');
  if (await isDirectory(courseProblemsDirectoryPath)) {
    return courseProblemsDirectoryPath;
  }
  const siblingProblemsDirectoryPath = join(courseDirectoryPath, '..', 'problems');
  if (await isDirectory(siblingProblemsDirectoryPath)) {
    return siblingProblemsDirectoryPath;
  }
  warnings.push('no problems directory found (pass --problems-dir); problem references are not checked');
  return undefined;
}

async function validateLectureDirectory(
  courseDirectoryPath: string,
  materialOptions: MaterialValidationOptions,
  lectureId: string,
  errors: string[],
  warnings: string[]
): Promise<void> {
  const lectureDirectoryPath = join(courseDirectoryPath, lectureId);
  if (!(await isDirectory(lectureDirectoryPath))) {
    errors.push(`lecture "${lectureId}": directory not found`);
    return;
  }

  const materialIds: string[] = [];
  const dirents = await readdir(lectureDirectoryPath, { withFileTypes: true });
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
