import { afterEach, describe, expect, test } from 'vitest';
import { appendFile, cp, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateCourseDirectory } from '../../src/learningMaterial/validateCourse.js';
import {
  cleanupTempDirs,
  copyFixtureToTempDir,
  createTempDir,
  learningMaterialFixturesDir,
} from './learningMaterialTestHelpers.js';

const problemsDir = join(learningMaterialFixturesDir, 'problems');
const validCourseDir = join(learningMaterialFixturesDir, 'courses', 'example_course');

describe('validateCourseDirectory', () => {
  afterEach(cleanupTempDirs);

  test('accepts the valid course fixture', async () => {
    const result = await validateCourseDirectory(validCourseDir, { problemsDirectoryPath: problemsDir });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('resolves the sibling problems directory by default', async () => {
    const tempDir = await createTempDir();
    await cp(validCourseDir, join(tempDir, 'example_course'), { recursive: true });
    await cp(problemsDir, join(tempDir, 'problems'), { recursive: true });
    const result = await validateCourseDirectory(join(tempDir, 'example_course'));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('resolves a course-scoped problems directory without reporting it as an orphan lecture', async () => {
    const tempDir = await createTempDir();
    const courseDir = join(tempDir, 'example_course');
    await cp(validCourseDir, courseDir, { recursive: true });
    await cp(problemsDir, join(courseDir, 'problems'), { recursive: true });

    const result = await validateCourseDirectory(courseDir);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('does not report the course-scoped problems directory as an orphan lecture with --problems-dir', async () => {
    const tempDir = await createTempDir();
    const courseDir = join(tempDir, 'example_course');
    await cp(validCourseDir, courseDir, { recursive: true });
    await cp(problemsDir, join(courseDir, 'problems'), { recursive: true });
    const result = await validateCourseDirectory(courseDir, { problemsDirectoryPath: problemsDir });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('warns when no problems directory is available', async () => {
    const tempDir = await createTempDir();
    await cp(validCourseDir, join(tempDir, 'example_course'), { recursive: true });
    const result = await validateCourseDirectory(join(tempDir, 'example_course'));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining('problem references are not checked')]);
  });

  test('rejects a missing course.yaml', async () => {
    const tempDir = await createTempDir();
    await mkdir(join(tempDir, 'empty_course'));
    const result = await validateCourseDirectory(join(tempDir, 'empty_course'), { problemsDirectoryPath: problemsDir });
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
    expect(result.errors).toEqual([expect.stringContaining('duplicate problem IDs: a_plus_b')]);
  });

  test('rejects an explicit question link that repeats a question block', async () => {
    const courseDir = await copyCourseFixture();
    await appendFile(join(courseDir, 'lecture_1', '10_intro.md'), '\n@[question](intro_select_1)\n');
    const result = await validateCourse(courseDir);
    expect(result.errors).toEqual([expect.stringContaining('duplicate question link IDs: intro_select_1')]);
  });

  test('rejects a problem reference that resolves only through a symbolic link', async () => {
    const tempDir = await createTempDir();
    await cp(validCourseDir, join(tempDir, 'example_course'), { recursive: true });
    await mkdir(join(tempDir, 'problems'));
    await symlink(join(problemsDir, 'a_plus_b'), join(tempDir, 'problems', 'a_plus_b'));
    const result = await validateCourseDirectory(join(tempDir, 'example_course'), {
      problemsDirectoryPath: join(tempDir, 'problems'),
    });
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

async function validateCourse(courseDir: string): ReturnType<typeof validateCourseDirectory> {
  return validateCourseDirectory(courseDir, { problemsDirectoryPath: problemsDir });
}

async function replaceInMaterial(courseDir: string, search: string, replacement: string): Promise<void> {
  const materialPath = join(courseDir, 'lecture_1', '10_intro.md');
  const content = await readFile(materialPath, 'utf8');
  expect(content).toContain(search);
  await writeFile(materialPath, content.replace(search, replacement));
}
