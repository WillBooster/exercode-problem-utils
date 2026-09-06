import { afterEach, describe, expect, test } from 'vitest';
import { appendFile, cp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateCourseDirectory } from '../../src/learningMaterial/validateCourse.js';
import { validateMaterialFile } from '../../src/learningMaterial/validateMaterial.js';
import {
  cleanupTempDirs,
  copyFixtureToTempDir,
  createTempDir,
  learningMaterialFixturesDir,
} from './learningMaterialTestHelpers.js';

const problemsDir = join(learningMaterialFixturesDir, 'courses', 'example_course', 'problems');
const validCourseDir = join(learningMaterialFixturesDir, 'courses', 'example_course');

describe('validateMaterialFile', () => {
  test('resolves problem references from problemsDirectoryPath on its own', async () => {
    const result = await validateMaterialFile(join(validCourseDir, 'lecture_1', '10_intro.md'), {
      problemsDirectoryPath: join(learningMaterialFixturesDir, 'contests'),
    });
    expect(result.errors).toEqual([
      expect.stringContaining('problem "a_plus_b" is referenced but does not exist'),
      expect.stringContaining('problem "arithmetic_subtraction" is referenced but does not exist'),
    ]);
  });
});

describe('validateMaterialFile', () => {
  test('reports a missing problems directory instead of throwing', async () => {
    const result = await validateMaterialFile(join(validCourseDir, 'lecture_1', '10_intro.md'), {
      problemsDirectoryPath: join(learningMaterialFixturesDir, 'no_such_dir'),
    });
    expect(result.errors).toEqual([expect.stringContaining('problems directory not found')]);
  });
});

describe('validateCourseDirectory', () => {
  afterEach(cleanupTempDirs);

  test('accepts the valid course fixture', async () => {
    const result = await validateCourseDirectory(validCourseDir, { problemsDirectoryPath: problemsDir });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('resolves problems nested anywhere inside the course by default', async () => {
    const tempDir = await createTempDir();
    const courseDir = join(tempDir, 'example_course');
    await cp(validCourseDir, courseDir, { recursive: true });
    await rename(join(courseDir, 'problems'), join(courseDir, 'lecture_1', 'nested_problems'));
    const result = await validateCourseDirectory(courseDir);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("does not count problems of a nested course as the enclosing course's", async () => {
    const tempDir = await createTempDir();
    const courseDir = join(tempDir, 'example_course');
    await cp(validCourseDir, courseDir, { recursive: true });
    await mkdir(join(courseDir, 'lecture_1', 'nested_course'));
    await writeFile(join(courseDir, 'lecture_1', 'nested_course', 'course.yaml'), 'name: nested\ndescription: d\n');
    await rename(join(courseDir, 'problems'), join(courseDir, 'lecture_1', 'nested_course', 'problems'));
    const result = await validateCourseDirectory(courseDir);
    expect(result.errors).toEqual([
      expect.stringContaining('problem "a_plus_b" is referenced but does not exist'),
      expect.stringContaining('problem "arithmetic_subtraction" is referenced but does not exist'),
    ]);
  });

  test('rejects a discovered problem whose ID is invalid', async () => {
    const courseDir = await copyCourseFixture();
    await mkdir(join(courseDir, 'problems', 'Bad-ID'));
    await writeFile(join(courseDir, 'problems', 'Bad-ID', 'problem.md'), '---\nname: bad\n---\n');
    const result = await validateCourseDirectory(courseDir);
    expect(result.errors).toEqual([
      expect.stringContaining('problem ID "Bad-ID" (problems/Bad-ID/problem.md) must match'),
    ]);
  });

  test('rejects a problem ID defined twice inside the course', async () => {
    const courseDir = await copyCourseFixture();
    await mkdir(join(courseDir, 'lecture_1', 'extra'));
    await writeFile(join(courseDir, 'lecture_1', 'extra', 'a_plus_b.problem.md'), '---\nname: dup\n---\n');
    const result = await validateCourseDirectory(courseDir);
    expect(result.errors).toEqual([expect.stringContaining('problem ID "a_plus_b" is defined more than once')]);
  });

  test('accepts --problems-dir naming a differently named directory inside the course', async () => {
    const courseDir = await copyCourseFixture();
    await rename(join(courseDir, 'problems'), join(courseDir, 'exercises'));
    const result = await validateCourseDirectory(courseDir, { problemsDirectoryPath: join(courseDir, 'exercises') });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('does not report an unlisted directory that holds no material file directly', async () => {
    const courseDir = await copyCourseFixture();
    await mkdir(join(courseDir, 'data'));
    await rename(join(courseDir, 'problems'), join(courseDir, 'data', 'problems'));
    const result = await validateCourseDirectory(courseDir);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('still reports an orphan directory when --problems-dir names a missing directory inside it', async () => {
    const courseDir = await copyCourseFixture();
    await mkdir(join(courseDir, 'data'));
    await writeFile(join(courseDir, 'data', 'orphan.md'), '# orphan\n');
    const result = await validateCourseDirectory(courseDir, {
      problemsDirectoryPath: join(courseDir, 'data', 'problems'),
    });
    expect(result.errors).toEqual([expect.stringContaining('problems directory not found')]);
    expect(result.warnings).toEqual([expect.stringContaining('directory "data" is not listed as a lecture')]);
  });

  test('does not report the conventional problems directory holding a note file', async () => {
    const courseDir = await copyCourseFixture();
    await writeFile(join(courseDir, 'problems', 'README.md'), '# Problems\n');
    const result = await validateCourseDirectory(courseDir);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('reports an unlisted directory that holds materials next to problems', async () => {
    const courseDir = await copyCourseFixture();
    await rename(join(courseDir, 'problems'), join(courseDir, 'data'));
    await cp(join(courseDir, 'lecture_1', '10_intro.md'), join(courseDir, 'data', 'orphan.md'));
    const result = await validateCourseDirectory(courseDir);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining('directory "data" is not listed as a lecture')]);
  });

  test('treats --problems-dir as course-internal when either path goes through a symbolic link', async () => {
    const tempDir = await createTempDir();
    const realParentDir = join(tempDir, 'real');
    const linkedParentDir = join(tempDir, 'link');
    await mkdir(realParentDir);
    await symlink(realParentDir, linkedParentDir);
    const courseDir = join(realParentDir, 'example_course');
    await cp(validCourseDir, courseDir, { recursive: true });
    await rename(join(courseDir, 'problems'), join(courseDir, 'exercises'));
    const result = await validateCourseDirectory(join(linkedParentDir, 'example_course'), {
      problemsDirectoryPath: join(courseDir, 'exercises'),
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('reports a symlinked --problems-dir once even when it names the conventional directory', async () => {
    const tempDir = await createTempDir();
    const courseDir = join(tempDir, 'example_course');
    await cp(validCourseDir, courseDir, { recursive: true });
    await rename(join(courseDir, 'problems'), join(tempDir, 'problems'));
    await symlink(join(tempDir, 'problems'), join(courseDir, 'problems'));
    const result = await validateCourseDirectory(courseDir, { problemsDirectoryPath: join(courseDir, 'problems') });
    expect(result.errors.filter((error) => error.includes('problems directory'))).toEqual([
      expect.stringContaining('problems directory is a symbolic link'),
    ]);
  });

  test('still discovers course-wide problems when --problems-dir names a subdirectory', async () => {
    const tempDir = await createTempDir();
    const courseDir = join(tempDir, 'example_course');
    await cp(validCourseDir, courseDir, { recursive: true });
    await rename(join(courseDir, 'problems', 'a_plus_b'), join(courseDir, 'lecture_1', 'a_plus_b'));
    const result = await validateCourseDirectory(courseDir, { problemsDirectoryPath: join(courseDir, 'problems') });
    expect(result.errors).toEqual([]);
  });

  test('reports a missing conventional problems directory named by --problems-dir', async () => {
    const courseDir = await copyCourseFixture();
    await rename(join(courseDir, 'problems'), join(courseDir, 'exercises'));
    const result = await validateCourseDirectory(courseDir, { problemsDirectoryPath: join(courseDir, 'problems') });
    expect(result.errors).toEqual([expect.stringContaining('problems directory not found')]);
  });

  test('still checks course-internal references when --problems-dir does not exist', async () => {
    const courseDir = await copyCourseFixture();
    const result = await validateCourseDirectory(courseDir, { problemsDirectoryPath: join(courseDir, 'missing') });
    expect(result.errors).toEqual([expect.stringContaining('problems directory not found')]);
    await appendFile(join(courseDir, 'lecture_1', '10_intro.md'), '\n[欠落](problems/missing_problem)\n');
    const secondResult = await validateCourseDirectory(courseDir, {
      problemsDirectoryPath: join(courseDir, 'missing'),
    });
    expect(secondResult.errors).toEqual([
      expect.stringContaining('problems directory not found'),
      expect.stringContaining('problem "missing_problem" is referenced but does not exist'),
    ]);
  });

  test('rejects --problems-dir outside the course and does not count its problems', async () => {
    const tempDir = await createTempDir();
    await cp(validCourseDir, join(tempDir, 'example_course'), { recursive: true });
    await rename(join(tempDir, 'example_course', 'problems'), join(tempDir, 'problems'));
    const result = await validateCourseDirectory(join(tempDir, 'example_course'), {
      problemsDirectoryPath: join(tempDir, 'problems'),
    });
    expect(result.errors).toEqual([
      expect.stringContaining('is outside the course directory'),
      expect.stringContaining('problem "a_plus_b" is referenced but does not exist'),
      expect.stringContaining('problem "arithmetic_subtraction" is referenced but does not exist'),
    ]);
  });

  test('rejects references when the course contains no problems', async () => {
    const tempDir = await createTempDir();
    await cp(validCourseDir, join(tempDir, 'example_course'), { recursive: true });
    await rm(join(tempDir, 'example_course', 'problems'), { recursive: true });
    const result = await validateCourseDirectory(join(tempDir, 'example_course'));
    expect(result.errors).toEqual([
      expect.stringContaining('problem "a_plus_b" is referenced but does not exist'),
      expect.stringContaining('problem "arithmetic_subtraction" is referenced but does not exist'),
    ]);
  });

  test('rejects a missing course.yaml', async () => {
    const tempDir = await createTempDir();
    await mkdir(join(tempDir, 'empty_course'));
    const result = await validateCourseDirectory(join(tempDir, 'empty_course'));
    expect(result.errors).toEqual([expect.stringContaining('course.yaml not found')]);
  });

  test('rejects an unknown key in course.yaml', async () => {
    const courseDir = await copyCourseFixture();
    await appendFile(join(courseDir, 'course.yaml'), 'unknownKey: true\n');
    const result = await validateCourse(courseDir);
    expect(result.errors).toEqual([expect.stringContaining('unknownKey')]);
  });

  test('rejects a lecture without a matching directory', async () => {
    const courseDir = await copyCourseFixture();
    await appendFile(
      join(courseDir, 'course.yaml'),
      '  - id: lecture_2\n    name: 第2回\n    description: 存在しない講義\n'
    );
    const result = await validateCourse(courseDir);
    expect(result.errors).toEqual([expect.stringContaining('lecture "lecture_2": directory not found')]);
  });

  test('rejects the same problem linked twice in a material body', async () => {
    const courseDir = await copyCourseFixture();
    await appendFile(join(courseDir, 'lecture_1', '10_intro.md'), '\n[もう一度](problems/a_plus_b)\n');
    const result = await validateCourse(courseDir);
    expect(result.errors).toEqual([expect.stringContaining('duplicate problem link IDs: a_plus_b')]);
  });

  test('rejects a duplicate problem link whose text spans lines', async () => {
    const courseDir = await copyCourseFixture();
    await appendFile(join(courseDir, 'lecture_1', '10_intro.md'), '\n[もう\n一度](problems/a_plus_b)\n');
    const result = await validateCourse(courseDir);
    expect(result.errors).toEqual([expect.stringContaining('duplicate problem link IDs: a_plus_b')]);
  });

  test('rejects a frontmatter problem that the body links as well', async () => {
    const courseDir = await copyCourseFixture();
    await replaceInMaterial(courseDir, 'name: 導入\n', 'name: 導入\nproblems:\n  - id: a_plus_b\n');
    const result = await validateCourse(courseDir);
    expect(result.errors).toEqual([expect.stringContaining('duplicate problem IDs: a_plus_b')]);
  });

  test('rejects an explicit question link that repeats a question block', async () => {
    const courseDir = await copyCourseFixture();
    await appendFile(join(courseDir, 'lecture_1', '10_intro.md'), '\n@[question](intro_select_1)\n');
    const result = await validateCourse(courseDir);
    expect(result.errors).toEqual([expect.stringContaining('duplicate question link IDs: intro_select_1')]);
  });

  test('rejects a symbolic link as the course-scoped problems directory', async () => {
    const tempDir = await createTempDir();
    const courseDir = join(tempDir, 'example_course');
    await cp(validCourseDir, courseDir, { recursive: true });
    await rename(join(courseDir, 'problems'), join(tempDir, 'real_problems'));
    await symlink(join(tempDir, 'real_problems'), join(courseDir, 'problems'));
    const result = await validateCourseDirectory(courseDir);
    // The linked problems are not discovered, so the references dangle as well.
    expect(result.errors[0]).toEqual(expect.stringContaining('problems directory is a symbolic link'));
    expect(result.errors).toContainEqual(
      expect.stringContaining('problem "a_plus_b" is referenced but does not exist')
    );
  });

  test('rejects a problem reference that resolves only through a symbolic link', async () => {
    const tempDir = await createTempDir();
    const courseDir = join(tempDir, 'example_course');
    await cp(validCourseDir, courseDir, { recursive: true });
    await rm(join(courseDir, 'problems', 'a_plus_b'), { recursive: true });
    await symlink(join(problemsDir, 'a_plus_b'), join(courseDir, 'problems', 'a_plus_b'));
    const result = await validateCourseDirectory(courseDir);
    expect(result.errors).toEqual([expect.stringContaining('problem "a_plus_b" is referenced but does not exist')]);
  });

  test('rejects a dangling problem reference in a material body', async () => {
    const courseDir = await copyCourseFixture();
    await replaceInMaterial(courseDir, '(problems/a_plus_b)', '(problems/missing_problem)');
    const result = await validateCourse(courseDir);
    expect(result.errors).toEqual([
      expect.stringContaining('problem "missing_problem" is referenced but does not exist'),
    ]);
  });

  test('rejects an answerIndex out of bounds', async () => {
    const courseDir = await copyCourseFixture();
    await replaceInMaterial(courseDir, 'answerIndex: 0', 'answerIndex: 5');
    const result = await validateCourse(courseDir);
    expect(result.errors).toEqual([expect.stringContaining('answerIndex out of bounds: 5')]);
  });

  test('rejects a non-numeric answerIndex as a schema error', async () => {
    const courseDir = await copyCourseFixture();
    await replaceInMaterial(courseDir, 'answerIndex: 0', "answerIndex: 'abc'");
    const result = await validateCourse(courseDir);
    expect(result.errors).toEqual([expect.stringContaining('question block 1: answerIndex')]);
  });

  test('rejects a select question without answerIndex when it is not a survey', async () => {
    const courseDir = await copyCourseFixture();
    await replaceInMaterial(courseDir, 'answerIndex: 0\n', '');
    const result = await validateCourse(courseDir);
    expect(result.errors).toEqual([expect.stringContaining('`answerIndex` is required when `isSurvey` is not true')]);
  });

  test('rejects duplicate question IDs', async () => {
    const courseDir = await copyCourseFixture();
    await appendFile(
      join(courseDir, 'lecture_1', '10_intro.md'),
      "\n```yaml question\nid: intro_select_1\ntype: select\nquestion: 重複した設問です。\noptions: ['a', 'b']\nanswerIndex: 1\n```\n"
    );
    const result = await validateCourse(courseDir);
    expect(result.errors).toEqual([
      expect.stringContaining('duplicate question IDs: intro_select_1'),
      expect.stringContaining('duplicate question link IDs: intro_select_1'),
    ]);
  });

  test('rejects a modelAnswer that does not match answerPattern', async () => {
    const courseDir = await copyCourseFixture();
    await appendFile(
      join(courseDir, 'lecture_1', '10_intro.md'),
      "\n```yaml question\nid: intro_text_1\ntype: text\nquestion: 加算演算子を答えなさい。\nanswerPattern: 'a\\s*\\+\\s*b'\nmodelAnswer: 'a - b'\n```\n"
    );
    const result = await validateCourse(courseDir);
    expect(result.errors).toEqual([expect.stringContaining("`modelAnswer` doesn't match `answerPattern`")]);
  });

  test('rejects an inverted submission period in material frontmatter', async () => {
    const courseDir = await copyCourseFixture();
    await replaceInMaterial(
      courseDir,
      'name: 導入\n',
      "name: 導入\nsubmissionOpenedAt: '2026-01-02T00:00:00+09:00'\nsubmissionSoftClosedAt: '2026-01-01T00:00:00+09:00'\n"
    );
    const result = await validateCourse(courseDir);
    expect(result.errors).toEqual([
      expect.stringContaining('submissionOpenedAt (2026-01-02T00:00:00+09:00) must be <= submissionSoftClosedAt'),
    ]);
  });

  test('accepts the = yaml = frontmatter delimiter the judge parser supports', async () => {
    const courseDir = await copyCourseFixture();
    const materialPath = join(courseDir, 'lecture_1', '10_intro.md');
    const content = await readFile(materialPath, 'utf8');
    expect(content.startsWith('---\n')).toBe(true);
    await writeFile(materialPath, content.replace('---\n', '= yaml =\n').replace('\n---\n', '\n= yaml =\n'));
    const result = await validateCourse(courseDir);
    expect(result.errors).toEqual([]);
  });

  test('accepts an example question fence nested in a longer-fenced question block', async () => {
    const courseDir = await copyCourseFixture();
    await appendFile(
      join(courseDir, 'lecture_1', '10_intro.md'),
      "\n````yaml question\nid: intro_nested_1\ntype: text\nquestion: |\n  次の形式で書きます。\n  ```yaml question\n  id: sample\n  ```\nanswerPattern: 'ok'\n````\n"
    );
    const result = await validateCourse(courseDir);
    expect(result.errors).toEqual([]);
  });

  test('accepts course.yml and rejects it next to course.yaml', async () => {
    const courseDir = await copyCourseFixture();
    await rename(join(courseDir, 'course.yaml'), join(courseDir, 'course.yml'));
    const result = await validateCourse(courseDir);
    expect(result.errors).toEqual([]);
    await cp(join(courseDir, 'course.yml'), join(courseDir, 'course.yaml'));
    const conflictResult = await validateCourse(courseDir);
    expect(conflictResult.errors).toEqual([expect.stringContaining('both course.yaml and course.yml exist')]);
  });

  test('rejects a symbolic link used as the course directory', async () => {
    const tempDir = await createTempDir();
    await symlink(validCourseDir, join(tempDir, 'example_course'));
    const result = await validateCourseDirectory(join(tempDir, 'example_course'), {
      problemsDirectoryPath: problemsDir,
    });
    expect(result.errors).toEqual([expect.stringContaining('course directory is a symbolic link')]);
  });

  test('rejects a symbolic link among lecture materials', async () => {
    const courseDir = await copyCourseFixture();
    await symlink('10_intro.md', join(courseDir, 'lecture_1', '20_linked.md'));
    const result = await validateCourse(courseDir);
    expect(result.errors).toEqual([expect.stringContaining('lecture_1/20_linked.md is a symbolic link')]);
  });

  test('rejects a course.yaml symbolic link', async () => {
    const courseDir = await copyCourseFixture();
    await rename(join(courseDir, 'course.yaml'), join(courseDir, 'course.real.yaml'));
    await symlink('course.real.yaml', join(courseDir, 'course.yaml'));
    const result = await validateCourse(courseDir);
    expect(result.errors).toEqual([expect.stringContaining('course.yaml is a symbolic link')]);
  });

  test('rejects invalid YAML in an embedded question block', async () => {
    const courseDir = await copyCourseFixture();
    await replaceInMaterial(courseDir, 'answerIndex: 0', 'answerIndex: [0');
    const result = await validateCourse(courseDir);
    expect(result.errors).toEqual([expect.stringContaining('question block 1: invalid YAML')]);
  });

  test('rejects more than one chat marker', async () => {
    const courseDir = await copyCourseFixture();
    await appendFile(join(courseDir, 'lecture_1', '10_intro.md'), '\n<!-- chat -->\n\nAI向けの補足\n\n<!-- chat -->\n');
    const result = await validateCourse(courseDir);
    expect(result.errors).toEqual([expect.stringContaining('at most one `<!-- chat -->` marker is allowed')]);
  });
});

async function copyCourseFixture(): Promise<string> {
  return copyFixtureToTempDir(join('courses', 'example_course'), 'example_course');
}

/** Validates a copied course fixture, whose problems live under its own `problems/`. */
async function validateCourse(courseDir: string): ReturnType<typeof validateCourseDirectory> {
  return validateCourseDirectory(courseDir);
}

async function replaceInMaterial(courseDir: string, search: string, replacement: string): Promise<void> {
  const materialPath = join(courseDir, 'lecture_1', '10_intro.md');
  const content = await readFile(materialPath, 'utf8');
  expect(content).toContain(search);
  await writeFile(materialPath, content.replace(search, replacement));
}
