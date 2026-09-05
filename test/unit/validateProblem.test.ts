import { afterEach, describe, expect, test } from 'vitest';
import { mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateProblemDirectory } from '../../src/learningMaterial/validateProblem.js';
import { cleanupTempDirs, copyFixtureToTempDir, learningMaterialFixturesDir } from './learningMaterialTestHelpers.js';

describe('validateProblemDirectory', () => {
  afterEach(cleanupTempDirs);

  test('accepts the valid a_plus_b fixture', async () => {
    const result = await validateProblemDirectory(
      join(learningMaterialFixturesDir, 'courses', 'example_course', 'problems', 'a_plus_b')
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('accepts the valid arithmetic_subtraction fixture', async () => {
    const result = await validateProblemDirectory(
      join(learningMaterialFixturesDir, 'courses', 'example_course', 'problems', 'arithmetic_subtraction')
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('rejects a directory that does not exist', async () => {
    const result = await validateProblemDirectory(
      join(learningMaterialFixturesDir, 'courses', 'example_course', 'problems', 'no_such_problem')
    );
    expect(result.errors).toEqual([expect.stringContaining('problem directory not found')]);
  });

  test('rejects an invalid problem ID (directory name)', async () => {
    const problemDir = await copyProblemFixture('A+B');
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([expect.stringContaining('problem ID "A+B"')]);
  });

  test('rejects a missing problem.md', async () => {
    const problemDir = await copyProblemFixture();
    await rm(join(problemDir, 'problem.md'));
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([expect.stringContaining('problem.md not found')]);
  });

  test('rejects a problem.md symbolic link and a template symbolic link', async () => {
    const problemDir = await copyProblemFixture();
    await rename(join(problemDir, 'problem.md'), join(problemDir, 'statement.md'));
    await symlink('statement.md', join(problemDir, 'problem.md'));
    await symlink('../model_answers/python/main.py', join(problemDir, 'templates', 'link.py'));
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([
      expect.stringContaining('problem.md is a symbolic link'),
      expect.stringContaining('templates/link.py is a symbolic link'),
    ]);
    await rm(join(problemDir, 'problem.md'));
    await rename(join(problemDir, 'statement.md'), join(problemDir, 'problem.md'));
    const templateResult = await validateProblemDirectory(problemDir);
    expect(templateResult.errors).toEqual([
      expect.stringContaining('templates/link.py is a symbolic link'),
      expect.stringContaining('templates/link.py must be a regular file or directory'),
    ]);
  });

  test('rejects a v1 problem file layout', async () => {
    const problemDir = await copyProblemFixture();
    await writeFile(join(problemDir, 'a_plus_b.problem.md'), '---\nname: A + B\n---\n');
    await writeFile(join(problemDir, 'old.problem.md'), '---\nname: A + B\n---\n');
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([
      expect.stringContaining('v1 problem file a_plus_b.problem.md'),
      expect.stringContaining('v1 problem file old.problem.md'),
    ]);
  });

  test('rejects an unknown frontmatter key', async () => {
    const problemDir = await copyProblemFixture();
    await setProblemFrontmatter(problemDir, 'name: A + B\nunknownKey: 1');
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([expect.stringContaining('unknownKey')]);
  });

  test('rejects a test case without an expected output', async () => {
    const problemDir = await copyProblemFixture();
    await rm(join(problemDir, 'test_cases', 'test_1.out'));
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([expect.stringContaining('test_1.out (or test_1.fout/) is missing')]);
  });

  test('accepts a test case without stdin and a file-based test case', async () => {
    const problemDir = await copyProblemFixture();
    await rm(join(problemDir, 'test_cases', 'test_1.in'));
    await rm(join(problemDir, 'test_cases', 'test_2.in'));
    await rm(join(problemDir, 'test_cases', 'test_2.out'));
    await mkdir(join(problemDir, 'test_cases', 'test_2.fin'));
    await writeFile(join(problemDir, 'test_cases', 'test_2.fin', 'a.txt'), '1\n');
    await mkdir(join(problemDir, 'test_cases', 'test_2.fout'));
    await writeFile(join(problemDir, 'test_cases', 'test_2.fout', 'c.txt'), '2\n');
    await mkdir(join(problemDir, 'test_cases', '_shared.fin'));
    await writeFile(join(problemDir, 'test_cases', '_shared.fin', 'common.txt'), 'x\n');
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('accepts input-only test cases with a custom judge.ts', async () => {
    const problemDir = await copyProblemFixture();
    for (const name of await readdir(join(problemDir, 'test_cases'))) {
      if (name.endsWith('.out')) await rm(join(problemDir, 'test_cases', name));
    }
    await writeFile(
      join(problemDir, 'judge.ts'),
      "import { parseArgs, printTestCaseResult } from '@exercode/problem-utils';\n// custom\n"
    );
    await writeFile(
      join(problemDir, 'debug.ts'),
      "import { stdioDebugPreset } from '@exercode/problem-utils/presets/stdio';\n"
    );
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([]);
  });

  test('warns about a partially missing .out with a custom judge.ts', async () => {
    const problemDir = await copyProblemFixture();
    await rm(join(problemDir, 'test_cases', 'test_1.out'));
    await writeFile(
      join(problemDir, 'judge.ts'),
      "import { parseArgs, printTestCaseResult } from '@exercode/problem-utils';\n// custom\n"
    );
    await writeFile(
      join(problemDir, 'debug.ts'),
      "import { stdioDebugPreset } from '@exercode/problem-utils/presets/stdio';\n"
    );
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining('test_1.out (or test_1.fout/) is missing while other cases have one'),
    ]);
  });

  test('rejects a .fin entry that is a file and an unsupported _shared.fout directory', async () => {
    const problemDir = await copyProblemFixture();
    await writeFile(join(problemDir, 'test_cases', 'test_1.fin'), 'not a directory\n');
    await mkdir(join(problemDir, 'test_cases', '_shared.fout'));
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([
      expect.stringContaining('_shared.fout is not supported'),
      expect.stringContaining('test_cases/test_1.fin must be a directory'),
    ]);
  });

  test('rejects an empty .fout next to a valid .out and skips identical stdin of file-input cases', async () => {
    const problemDir = await copyProblemFixture();
    await mkdir(join(problemDir, 'test_cases', 'test_1.fin'));
    await writeFile(join(problemDir, 'test_cases', 'test_1.fin', 'a.txt'), 'x\n');
    await writeFile(
      join(problemDir, 'test_cases', 'test_1.in'),
      await readFile(join(problemDir, 'test_cases', 'test_2.in'), 'utf8')
    );
    await mkdir(join(problemDir, 'test_cases', 'test_1.fout'));
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([expect.stringContaining('test_1.fout/ is empty')]);
    expect(result.warnings).toEqual([]);
  });

  test('rejects an empty .fout directory', async () => {
    const problemDir = await copyProblemFixture();
    await rm(join(problemDir, 'test_cases', 'test_1.in'));
    await rm(join(problemDir, 'test_cases', 'test_2.out'));
    await mkdir(join(problemDir, 'test_cases', 'test_2.fout'));
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([
      expect.stringContaining('test_2.fout/ is empty'),
      expect.stringContaining('test_2.out (or test_2.fout/) is missing'),
    ]);
    expect(result.warnings).toEqual([]);
  });

  test('accepts a test case without an expected output when the frontmatter judges the problem', async () => {
    const problemDir = await copyProblemFixture();
    await rm(join(problemDir, 'test_cases', 'test_1.out'));
    await setProblemFrontmatter(problemDir, 'name: A + B\nrequiredOutputFilePaths:\n  - result.txt');
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('accepts a .json test case configuration only with a custom judge.ts', async () => {
    const problemDir = await copyProblemFixture();
    await writeFile(join(problemDir, 'test_cases', 'test_1.json'), '{ "anything": true }\n');
    const withoutJudge = await validateProblemDirectory(problemDir);
    expect(withoutJudge.errors).toEqual([
      expect.stringContaining('test_1.json is configuration for a custom judge.ts'),
    ]);

    await writeFile(
      join(problemDir, 'judge.ts'),
      "import { parseArgs, printTestCaseResult } from '@exercode/problem-utils';\n// custom\n"
    );
    await writeFile(
      join(problemDir, 'debug.ts'),
      "import { stdioDebugPreset } from '@exercode/problem-utils/presets/stdio';\n"
    );
    const withJudge = await validateProblemDirectory(problemDir);
    expect(withJudge.errors).toEqual([]);
  });

  test('rejects test case IDs without any example or without any hidden test case', async () => {
    const problemDir = await copyProblemFixture();
    await rename(join(problemDir, 'test_cases', 'example_1.in'), join(problemDir, 'test_cases', 'test_8.in'));
    await rename(join(problemDir, 'test_cases', 'example_1.out'), join(problemDir, 'test_cases', 'test_8.out'));
    await rename(join(problemDir, 'test_cases', 'example_2.in'), join(problemDir, 'test_cases', 'test_9.in'));
    await rename(join(problemDir, 'test_cases', 'example_2.out'), join(problemDir, 'test_cases', 'test_9.out'));
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([expect.stringContaining('no example test case found')]);
  });

  test('rejects a case-less prompt_study problem without isManualScoringRequired', async () => {
    const problemDir = await copyProblemFixture();
    await rm(join(problemDir, 'test_cases'), { recursive: true });
    await setProblemFrontmatter(problemDir, 'name: Prompt study\ntype: prompt_study');
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toContainEqual(expect.stringContaining('no test cases found'));
  });

  test('rejects a case-less problem even when static-analysis rules are declared', async () => {
    const problemDir = await copyProblemFixture();
    await rm(join(problemDir, 'test_cases'), { recursive: true });
    await setProblemFrontmatter(problemDir, "name: A + B\nrequiredRegExpsInCode: ['\\+']");
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([expect.stringContaining('no test cases found')]);
  });

  test('accepts a CRLF problem.md like the judge does', async () => {
    const problemDir = await copyProblemFixture();
    const problemPath = join(problemDir, 'problem.md');
    const problemMarkdown = await readFile(problemPath, 'utf8');
    await writeFile(problemPath, problemMarkdown.replaceAll('\n', '\r\n'));
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([]);
  });

  test('rejects the frontmatter keys removed with the v1 judge', async () => {
    const problemDir = await copyProblemFixture();
    await setProblemFrontmatter(
      problemDir,
      'name: A + B\ntestCases:\n  - id: extra\n    name: Extra\njudgeEnvironmentId: general\nisGui: false'
    );
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors.length).toBeGreaterThan(0);
    const joinedErrors = result.errors.join('\n');
    expect(joinedErrors).toContain('testCases');
    expect(joinedErrors).toContain('judgeEnvironmentId');
    expect(joinedErrors).toContain('isGui');
  });

  test('rejects a forbidden regexp that matches a model answer', async () => {
    const problemDir = await copyProblemFixture();
    await setProblemFrontmatter(problemDir, "name: A + B\nforbiddenRegExpsInCode: ['console']");
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([
      expect.stringContaining('forbidden pattern "console" matches model answer file javascript/main.mjs'),
    ]);
  });

  test('ignores comments when matching forbidden texts against model answers', async () => {
    const problemDir = await copyProblemFixture();
    // The forbidden text appears only inside a comment, which the judge strips before matching.
    await writeFile(
      join(problemDir, 'model_answers', 'python', 'main.py'),
      'a, b = map(int, input().split())  # some_forbidden_name\nprint(a + b)\n'
    );
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([]);
  });

  test('rejects a forbidden text that appears in a model answer', async () => {
    const problemDir = await copyProblemFixture();
    await writeFile(
      join(problemDir, 'model_answers', 'python', 'main.py'),
      'some_forbidden_name = input().split()\nprint(int(some_forbidden_name[0]) + int(some_forbidden_name[1]))\n'
    );
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([expect.stringContaining('forbidden text "some_forbidden_name"')]);
  });

  test('rejects a required regexp that no model answer file matches', async () => {
    const problemDir = await copyProblemFixture();
    await setProblemFrontmatter(problemDir, "name: A + B\nrequiredRegExpsInCode: ['\\bfoobar\\b']");
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([
      expect.stringContaining(
        String.raw`required pattern "\bfoobar\b" does not match any file of model answer "javascript"`
      ),
      expect.stringContaining(
        String.raw`required pattern "\bfoobar\b" does not match any file of model answer "python"`
      ),
    ]);
  });

  test('rejects a model answer that lacks a required submission file', async () => {
    const problemDir = await copyProblemFixture();
    await setProblemFrontmatter(problemDir, 'name: A + B\nrequiredSubmissionFilePaths: [data.txt]');
    await writeFile(join(problemDir, 'model_answers', 'python', 'data.txt'), 'x\n');
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([
      expect.stringContaining('required submission file "data.txt" is missing from model answer "javascript"'),
    ]);
  });

  test('rejects an invalid regular expression', async () => {
    const problemDir = await copyProblemFixture();
    await setProblemFrontmatter(problemDir, "name: A + B\nrequiredRegExpsInCode: ['[']");
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([expect.stringContaining('invalid regular expression in requiredRegExpsInCode: [')]);
  });

  test('warns when a forbidden pattern restricts stdin-parsing helpers', async () => {
    const problemDir = await copyProblemFixture();
    await setProblemFrontmatter(
      problemDir,
      "name: A + B\nforbiddenRegExpsInCode: ['\\bScanner\\b']\nforbiddenTextsInCode: ['split', 'print']"
    );
    const result = await validateProblemDirectory(problemDir);
    expect(result.warnings).toEqual([
      expect.stringContaining(String.raw`pattern "\bScanner\b" matches typical stdin-parsing code`),
      expect.stringContaining('text "split" appears in typical stdin-parsing code'),
    ]);
  });

  test('rejects a default stdio judge.ts (the judge auto-generates it)', async () => {
    const problemDir = await copyProblemFixture();
    await writeFile(
      join(problemDir, 'judge.ts'),
      "import { stdioJudgePreset } from '@exercode/problem-utils/presets/stdio';\n\nawait stdioJudgePreset(import.meta.dirname);\n"
    );
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([expect.stringContaining('judge.ts only calls stdioJudgePreset; delete it')]);
  });

  test('rejects a semicolon-free default stdio judge.ts', async () => {
    const problemDir = await copyProblemFixture();
    await writeFile(
      join(problemDir, 'judge.ts'),
      'import { stdioJudgePreset } from "@exercode/problem-utils/presets/stdio"\n\nawait stdioJudgePreset(import.meta.dirname)\n'
    );
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([expect.stringContaining('judge.ts only calls stdioJudgePreset; delete it')]);
    expect(result.warnings).toEqual([]);
  });

  test('rejects default judge.ts and debug.ts together in a single pass', async () => {
    const problemDir = await copyProblemFixture();
    await writeFile(
      join(problemDir, 'judge.ts'),
      "import { stdioJudgePreset } from '@exercode/problem-utils/presets/stdio';\n\nawait stdioJudgePreset(import.meta.dirname);\n"
    );
    await writeFile(
      join(problemDir, 'debug.ts'),
      "import { stdioDebugPreset } from '@exercode/problem-utils/presets/stdio';\n\nawait stdioDebugPreset(import.meta.dirname);\n"
    );
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([
      expect.stringContaining('judge.ts only calls stdioJudgePreset; delete it'),
      expect.stringContaining('debug.ts only calls stdioDebugPreset; delete it'),
    ]);
  });

  test('warns about a manual-scoring custom judge.ts without debug.ts', async () => {
    const problemDir = await copyProblemFixture();
    await setProblemFrontmatter(problemDir, 'name: A + B\nisManualScoringRequired: true');
    await writeFile(
      join(problemDir, 'judge.ts'),
      "import { parseArgs, printTestCaseResult } from '@exercode/problem-utils';\n// custom\n"
    );
    const result = await validateProblemDirectory(problemDir);
    expect(result.warnings).toContainEqual(expect.stringContaining('custom judge.ts without debug.ts'));
  });

  test('rejects an import-aliased default judge.ts and debug.ts', async () => {
    const problemDir = await copyProblemFixture();
    await writeFile(
      join(problemDir, 'judge.ts'),
      "import { stdioJudgePreset as judge } from '@exercode/problem-utils/presets/stdio';\n\nawait judge(import.meta.dirname);\n"
    );
    await writeFile(
      join(problemDir, 'debug.ts'),
      "import { stdioDebugPreset as debug } from '@exercode/problem-utils/presets/stdio';\n\nawait debug(import.meta.dirname);\n"
    );
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([
      expect.stringContaining('judge.ts only calls stdioJudgePreset; delete it'),
      expect.stringContaining('debug.ts only calls stdioDebugPreset; delete it'),
    ]);
  });

  test('rejects a multiline default judge.ts and debug.ts with trailing commas', async () => {
    const problemDir = await copyProblemFixture();
    await writeFile(
      join(problemDir, 'judge.ts'),
      "import {\n  stdioJudgePreset,\n} from '@exercode/problem-utils/presets/stdio';\n\nawait stdioJudgePreset(import.meta.dirname);\n"
    );
    await writeFile(
      join(problemDir, 'debug.ts'),
      "import {\n  stdioDebugPreset,\n} from '@exercode/problem-utils/presets/stdio';\n\nawait stdioDebugPreset(import.meta.dirname);\n"
    );
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([
      expect.stringContaining('judge.ts only calls stdioJudgePreset; delete it'),
      expect.stringContaining('debug.ts only calls stdioDebugPreset; delete it'),
    ]);
  });

  test('rejects a default judge.ts written with an import alias', async () => {
    const problemDir = await copyProblemFixture();
    await writeFile(
      join(problemDir, 'judge.ts'),
      "import { stdioJudgePreset as $judge } from '@exercode/problem-utils/presets/stdio';\nawait $judge(import.meta.dirname);\n"
    );
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([expect.stringContaining('judge.ts only calls stdioJudgePreset; delete it')]);
    expect(result.warnings).toEqual([]);
  });

  test('treats a default-shaped judge.ts with a comment or a path literal as a custom harness', async () => {
    // Same rule as `exercode-problem judge`: an explanatory comment (or any other difference) marks
    // a harness kept on purpose, so only the missing debug.ts is reported.
    const variants = [
      "// kept to demonstrate the default harness\nimport { stdioJudgePreset } from '@exercode/problem-utils/presets/stdio';\n\nawait stdioJudgePreset(import.meta.dirname);\n",
      "import { stdioJudgePreset } from '@exercode/problem-utils/presets/stdio';\nawait stdioJudgePreset('/abs/path/to/a_plus_b');\n",
    ];
    for (const variant of variants) {
      const problemDir = await copyProblemFixture();
      await writeFile(join(problemDir, 'judge.ts'), variant);
      const result = await validateProblemDirectory(problemDir);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([expect.stringContaining('custom judge.ts without debug.ts')]);
      await cleanupTempDirs();
    }
  });

  test('reports the default judge.ts and the missing test cases in a single pass', async () => {
    const problemDir = await copyProblemFixture();
    await rm(join(problemDir, 'test_cases'), { recursive: true });
    // The fixture's code rules would make the problem judgeable without test cases.
    await setProblemFrontmatter(problemDir, 'name: A + B');
    await writeFile(
      join(problemDir, 'judge.ts'),
      "import { stdioJudgePreset } from '@exercode/problem-utils/presets/stdio';\n\nawait stdioJudgePreset(import.meta.dirname);\n"
    );
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([
      expect.stringContaining('no test cases found'),
      expect.stringContaining('judge.ts only calls stdioJudgePreset; delete it'),
    ]);
  });

  test('accepts a default debug.ts next to a custom judge.ts', async () => {
    const problemDir = await copyProblemFixture();
    await writeFile(
      join(problemDir, 'judge.ts'),
      "import { parseArgs, printTestCaseResult } from '@exercode/problem-utils';\n// custom\n"
    );
    await writeFile(
      join(problemDir, 'debug.ts'),
      "import { stdioDebugPreset } from '@exercode/problem-utils/presets/stdio';\n\nawait stdioDebugPreset(import.meta.dirname);\n"
    );
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('accepts a custom debug.ts without judge.ts (the judge runs it for debugging)', async () => {
    const problemDir = await copyProblemFixture();
    await writeFile(join(problemDir, 'debug.ts'), "import { parseArgs } from '@exercode/problem-utils';\n// custom\n");
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('rejects a default stdio debug.ts on a problem without judge.ts', async () => {
    const problemDir = await copyProblemFixture();
    await writeFile(
      join(problemDir, 'debug.ts'),
      "import { stdioDebugPreset } from '@exercode/problem-utils/presets/stdio';\n\nawait stdioDebugPreset(import.meta.dirname);\n"
    );
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([expect.stringContaining('debug.ts only calls stdioDebugPreset; delete it')]);
  });

  test('warns about a custom judge.ts without debug.ts and accepts it with a custom debug.ts', async () => {
    const problemDir = await copyProblemFixture();
    const customJudgeTs = "import { parseArgs, printTestCaseResult } from '@exercode/problem-utils';\n// custom\n";
    await writeFile(join(problemDir, 'judge.ts'), customJudgeTs);
    const withoutDebug = await validateProblemDirectory(problemDir);
    expect(withoutDebug.errors).toEqual([]);
    expect(withoutDebug.warnings).toEqual([expect.stringContaining('custom judge.ts without debug.ts')]);

    await writeFile(join(problemDir, 'debug.ts'), customJudgeTs);
    const withDebug = await validateProblemDirectory(problemDir);
    expect(withDebug.errors).toEqual([]);
    expect(withDebug.warnings).toEqual([]);
  });

  test('rejects model answers that hold no runnable source file', async () => {
    const problemDir = await copyProblemFixture();
    await setProblemFrontmatter(problemDir, 'name: A + B');
    await rm(join(problemDir, 'model_answers'), { recursive: true });
    await mkdir(join(problemDir, 'model_answers', 'python'), { recursive: true });
    await writeFile(join(problemDir, 'model_answers', 'python', 'README.md'), '# notes\n');
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([
      expect.stringContaining('model answer directory "python" has no source file of a supported language'),
    ]);
  });

  test('accepts a data-file model answer for a custom judge and checks its required files', async () => {
    const problemDir = await copyProblemFixture();
    await setProblemFrontmatter(problemDir, 'name: Evaluation\nrequiredSubmissionFilePaths: [submission.csv]');
    await rm(join(problemDir, 'test_cases'), { recursive: true });
    await writeFile(join(problemDir, 'judge.ts'), "import { parseArgs } from '@exercode/problem-utils';\n// custom\n");
    await writeFile(join(problemDir, 'debug.ts'), "import { parseArgs } from '@exercode/problem-utils';\n// custom\n");
    await rm(join(problemDir, 'model_answers'), { recursive: true });
    await mkdir(join(problemDir, 'model_answers', 'default'), { recursive: true });
    await writeFile(join(problemDir, 'model_answers', 'default', 'submission.csv'), 'id,value\n1,2\n');
    const acceptedResult = await validateProblemDirectory(problemDir);
    expect(acceptedResult.errors).toEqual([]);
    await rename(
      join(problemDir, 'model_answers', 'default', 'submission.csv'),
      join(problemDir, 'model_answers', 'default', 'notes.csv')
    );
    const missingResult = await validateProblemDirectory(problemDir);
    expect(missingResult.errors).toEqual([
      expect.stringContaining('required submission file "submission.csv" is missing'),
    ]);
  });

  test('rejects an empty model answer directory', async () => {
    const problemDir = await copyProblemFixture();
    await rm(join(problemDir, 'model_answers', 'javascript', 'main.mjs'));
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([expect.stringContaining('model answer directory "javascript" has no source files')]);
  });

  test('rejects missing model answers', async () => {
    const problemDir = await copyProblemFixture();
    await setProblemFrontmatter(problemDir, 'name: A + B');
    await rm(join(problemDir, 'model_answers'), { recursive: true });
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([expect.stringContaining('no model answers found')]);
  });

  test('warns when a template file is identical to a model answer file', async () => {
    const problemDir = await copyProblemFixture();
    const modelAnswer = await readFile(join(problemDir, 'model_answers', 'python', 'main.py'), 'utf8');
    await writeFile(join(problemDir, 'templates', '_default', 'main.py'), modelAnswer);
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining('identical to a model answer file')]);
  });

  test('reports duplicate test inputs, empty outputs, and too few test cases', async () => {
    const problemDir = await copyProblemFixture();
    await rm(join(problemDir, 'test_cases', 'test_2.in'));
    await rm(join(problemDir, 'test_cases', 'test_2.out'));
    const example1 = await readFile(join(problemDir, 'test_cases', 'example_1.in'), 'utf8');
    await writeFile(join(problemDir, 'test_cases', 'test_1.in'), example1);
    await writeFile(join(problemDir, 'test_cases', 'test_1.out'), '');
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining('test_1: .out is empty'),
      expect.stringContaining('example_1 and test_1 have identical input'),
      expect.stringContaining('only 3 test cases found'),
    ]);
  });

  test('rejects a .fout that holds only an empty subdirectory or an oversized expected file', async () => {
    const problemDir = await copyProblemFixture();
    await rm(join(problemDir, 'test_cases', 'test_1.out'));
    await mkdir(join(problemDir, 'test_cases', 'test_1.fout', 'nested'), { recursive: true });
    await rm(join(problemDir, 'test_cases', 'test_2.out'));
    await mkdir(join(problemDir, 'test_cases', 'test_2.fout'));
    await writeFile(join(problemDir, 'test_cases', 'test_2.fout', 'big.txt'), Buffer.alloc(8 * 1024 * 1024 + 1));
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([
      expect.stringContaining('test_1.fout/ is empty'),
      expect.stringContaining('test_2.fout/big.txt is larger than'),
      expect.stringContaining('test_1.out (or test_1.fout/) is missing'),
    ]);
  });

  test('rejects an expected stdout the stdio judge could never accept', async () => {
    const problemDir = await copyProblemFixture();
    await writeFile(join(problemDir, 'test_cases', 'test_1.out'), `${'x'.repeat(50_000)}\n`);
    const result = await validateProblemDirectory(problemDir);
    expect(result.errors).toEqual([expect.stringContaining('test_1: .out is too large (length: 50001')]);
    await writeFile(join(problemDir, 'test_cases', 'test_1.out'), 'x'.repeat(50_000));
    const boundaryResult = await validateProblemDirectory(problemDir);
    expect(boundaryResult.errors).toEqual([]);
  });
});

async function copyProblemFixture(targetName = 'a_plus_b'): Promise<string> {
  return copyFixtureToTempDir(join('courses', 'example_course', 'problems', 'a_plus_b'), targetName);
}

/** Rewrites the fixture problem.md frontmatter while keeping the Markdown body intact. */
async function setProblemFrontmatter(problemDir: string, frontmatterYaml: string): Promise<void> {
  const problemFilePath = join(problemDir, 'problem.md');
  const content = await readFile(problemFilePath, 'utf8');
  const bodyStart = content.indexOf('\n---\n') + '\n---\n'.length;
  await writeFile(problemFilePath, `---\n${frontmatterYaml}\n---\n${content.slice(bodyStart)}`);
}
