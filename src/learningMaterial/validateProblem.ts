import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

import { MAX_COMPARED_FILE_BYTES } from '../helpers/compareExpectedOutputFiles.js';
import { findDefaultStdioHarnessFiles, type HarnessFileName } from '../helpers/defaultStdioHarness.js';
import { findLanguageDefinitionByPath } from '../helpers/findLanguageDefinitionByPath.js';
import { judgesTestCasesWithoutExpectations } from '../helpers/readProblemMarkdownFrontMatter.js';
import { removeCommentsInSourceCode } from '../helpers/removeCommentsInSourceCode.js';
import { EXAMPLE_TEST_CASE_ID_PATTERN, MAX_STDOUT_LENGTH } from '../helpers/stdioJudgeRules.js';
import { type CodeRule, normalizeCodeRule } from '../types/problem.js';

import { parseFrontmatter } from './frontmatter.js';
import {
  isDirectory,
  isFile,
  isRegularDirectory,
  isRegularFile,
  readSourceFilesRecursively,
  type SourceFile,
} from './fsHelpers.js';
import {
  availableLanguageIds,
  LEARNING_MATERIAL_ID_REGEX,
  problemFrontmatterSchema,
  type ProblemFrontmatter,
} from './schemas.js';
import { reportExcessChatMarkers } from './validateMaterial.js';
import { formatZodIssues, type ValidationResult } from './validationResult.js';

const RECOMMENDED_MIN_TEST_CASE_COUNT = 4;
// Forbidden patterns must not restrict classes/functions commonly needed just to parse stdin (from gen-em).
// Instead of a substring check on the pattern source ("print" contains "int"), each forbidden
// pattern is applied to representative parsing code; a hit means the pattern would forbid parsing.
const ALLOWED_PARSING_HELPERS = ['Scanner', 'map', 'int', 'split'] as const;
const PARSING_CODE_SNIPPETS = [
  'a, b = map(int, input().split())',
  'Scanner scanner = new Scanner(System.in);',
  "const [a, b] = line.split(' ').map(Number);",
] as const;

interface FileTestCase {
  id: string;
  stdin?: string;
  stdout?: string;
  /** Whether `<id>.fin/` (input files copied into the working directory) exists and holds at least one file. */
  hasFileInput: boolean;
  /** Whether `<id>.fout/` (expected output files) exists and holds at least one file. */
  hasFileOutput: boolean;
  /** Whether `<id>.json` (configuration read by a custom `judge.ts`) exists. */
  hasJudgeConfig: boolean;
}

// The importer rejects a longer expected stdout whichever judge the problem has.
const IMPORTER_MAX_STDOUT_LENGTH = 100_000;
// `_shared.fin/` holds files copied for every test case; it is not a test case itself.
const SHARED_FILE_INPUT_NAME = '_shared';
// The importer leaves generated artifacts out of the packaged problem, so a directory holding only
// these is as good as empty. Any other file counts, even a `.gitkeep` placeholder.
const IGNORED_TEST_CASE_ENTRY_NAMES: ReadonlySet<string> = new Set(['.DS_Store', '__pycache__']);

interface ModelAnswer {
  id: string;
  files: SourceFile[];
}

/**
 * Validates a judge v2 problem directory (problem.md, test_cases, model_answers, templates, and —
 * for custom judging or custom debugging only — judge.ts/debug.ts).
 */
export async function validateProblemDirectory(problemDirectoryPath: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const result = { errors, warnings };

  const absoluteDirectoryPath = resolve(problemDirectoryPath);
  // Problem discovery does not traverse a symbolic link, so a linked problem directory is never imported.
  if (!(await isRegularDirectory(absoluteDirectoryPath))) {
    errors.push(
      (await isDirectory(absoluteDirectoryPath))
        ? `problem directory is a symbolic link, which the judge does not traverse: ${problemDirectoryPath}`
        : `problem directory not found: ${problemDirectoryPath}`
    );
    return result;
  }

  const problemId = basename(absoluteDirectoryPath);
  if (!LEARNING_MATERIAL_ID_REGEX.test(problemId)) {
    errors.push(`problem ID "${problemId}" (directory name) must match ${LEARNING_MATERIAL_ID_REGEX}`);
  }
  // The judge's front-matter reader takes the first `problem.md` or `*.problem.md` it finds, so a
  // leftover v1 file can be judged instead of problem.md.
  // The judge readers enumerate regular files and directories only, so a symbolic link anywhere in
  // the problem is ignored at import time and would silently drop or change what is judged.
  for (const linkPath of await listSymbolicLinks(absoluteDirectoryPath)) {
    errors.push(
      `${relative(absoluteDirectoryPath, linkPath)} is a symbolic link, which the judge ignores; commit a real file or directory`
    );
  }
  const problemDirents = await readdir(absoluteDirectoryPath, { withFileTypes: true });
  for (const dirent of problemDirents.toSorted((d1, d2) => d1.name.localeCompare(d2.name))) {
    if (dirent.isFile() && dirent.name.endsWith('.problem.md')) {
      errors.push(`found v1 problem file ${dirent.name}; use the v2 layout with a file named exactly problem.md`);
    }
  }

  const problemFilePath = join(absoluteDirectoryPath, 'problem.md');
  // The judge discovers problems by their problem.md and skips symbolic links (reported above).
  if (!(await isRegularFile(problemFilePath))) {
    if (!(await isFile(problemFilePath))) {
      errors.push('problem.md not found; a v2 problem directory must contain problem.md');
    }
    return result;
  }

  const frontmatter = await parseProblemFrontmatter(problemFilePath, errors);
  const harness = await readHarnessFiles(absoluteDirectoryPath);
  const requiresExpectedOutput = frontmatter === undefined || !judgesTestCasesWithoutExpectations(frontmatter);
  const fileTestCases = await readFileTestCases(
    absoluteDirectoryPath,
    { hasCustomJudgeTs: harness.hasCustomJudgeTs, requiresExpectedOutput },
    errors,
    warnings
  );
  // A default judge.ts is about to be deleted, so treat only a genuinely custom judge.ts as a
  // special judge; otherwise the case-less error would surface only after the deletion.
  validateTestCasePresence(frontmatter, fileTestCases, harness.hasCustomJudgeTs, errors, warnings);

  // A problem whose frontmatter failed to parse already has a primary error; deriving secondary
  // judge.ts/model-answer errors from it would send the fix loop after the wrong problems.
  const isScoredAutomatically =
    frontmatter !== undefined && frontmatter.isManualScoringRequired !== true && frontmatter.type !== 'prompt_study';
  validateHarnessFiles(harness, frontmatter !== undefined, errors, warnings);

  const modelAnswers = await readModelAnswers(absoluteDirectoryPath, errors, warnings);
  // Every model answer directory is judged by the all-problem check, so each one must hold what
  // its judge runs: a custom judge defines that itself (e.g. a CSV submission), while the stdio
  // judge needs a non-empty file of a supported language as its entry point.
  const usableModelAnswers = modelAnswers.filter((answer) => {
    const hasContent = answer.files.some((file) => file.data.trim().length > 0);
    const isRunnable = answer.files.some(
      (file) => findLanguageDefinitionByPath(file.path) !== undefined && file.data.trim().length > 0
    );
    if (!hasContent) {
      errors.push(`model answer directory "${answer.id}" has only empty files; add the answer or delete it`);
    } else if (!harness.hasCustomJudgeTs && !isRunnable) {
      errors.push(
        `model answer directory "${answer.id}" has no source file of a supported language, which the stdio judge needs as its entry point`
      );
    }
    return hasContent;
  });
  if (isScoredAutomatically && modelAnswers.length === 0) {
    errors.push('no model answers found; add at least one model_answers/<languageId>/ directory with non-empty files');
  }
  if (frontmatter) {
    validateCodePatterns(frontmatter, usableModelAnswers, errors, warnings);
    validateRequiredSubmissionFiles(frontmatter, usableModelAnswers, errors);
  }
  await validateTemplates(absoluteDirectoryPath, usableModelAnswers, harness.hasCustomJudgeTs, errors, warnings);

  return result;
}

interface HarnessFiles {
  hasDebugTs: boolean;
  rejectedDefaultHarnessFileNames: readonly HarnessFileName[];
  hasCustomJudgeTs: boolean;
}

async function readHarnessFiles(absoluteDirectoryPath: string): Promise<HarnessFiles> {
  const hasJudgeTs = await isFile(join(absoluteDirectoryPath, 'judge.ts'));
  // The same policy the `judge` subcommand and the all-problem check apply: a default judge.ts is
  // always rejected, and a default debug.ts is rejected unless it accompanies a custom judge.ts.
  const defaultHarnessFileNames = await findDefaultStdioHarnessFiles(absoluteDirectoryPath);
  return {
    hasDebugTs: await isFile(join(absoluteDirectoryPath, 'debug.ts')),
    rejectedDefaultHarnessFileNames: defaultHarnessFileNames,
    hasCustomJudgeTs: hasJudgeTs && !defaultHarnessFileNames.includes('judge.ts'),
  };
}

/**
 * The judge treats a problem without judge.ts as a standard stdin/stdout problem and auto-generates
 * both the stdio judge and the stdio debug runner. Committed copies of those default harnesses are
 * rejected: they add nothing and can drift from the server's defaults, and a default judge.ts also
 * hides the standard-problem marker that enables the default debug runner.
 */
function validateHarnessFiles(
  harness: HarnessFiles,
  hasParsedFrontmatter: boolean,
  errors: string[],
  warnings: string[]
): void {
  if (harness.rejectedDefaultHarnessFileNames.includes('judge.ts')) {
    errors.push(
      'judge.ts only calls stdioJudgePreset; delete it — the judge auto-generates it, and only a problem without judge.ts is treated as a standard stdio problem (which enables the default debug runner)'
    );
  }
  if (harness.rejectedDefaultHarnessFileNames.includes('debug.ts')) {
    errors.push(
      'debug.ts only calls stdioDebugPreset; delete it — the judge auto-generates it for problems without judge.ts'
    );
  }
  // A custom debug.ts without judge.ts stays accepted: the judge runs debug.ts whenever it is
  // present (judge.ts only selects the judging side), so it is a supported way to customize
  // debugging for a problem judged by the default stdio judge.
  // The debug feature itself is independent of the scoring mode, so warn for manual-scoring and
  // prompt_study problems too.
  if (hasParsedFrontmatter && harness.hasCustomJudgeTs && !harness.hasDebugTs) {
    warnings.push(
      "custom judge.ts without debug.ts; the debug feature is unavailable for this problem — add debug.ts (e.g. calling stdioDebugPreset from '@exercode/problem-utils/presets/stdio') or a custom debug harness"
    );
  }
}

async function parseProblemFrontmatter(
  problemFilePath: string,
  errors: string[]
): Promise<ProblemFrontmatter | undefined> {
  let attributes: unknown;
  try {
    let body: string;
    ({ attributes, body } = parseFrontmatter(await readFile(problemFilePath, 'utf8')));
    // exercode rejects problem bodies with more than one standalone chat delimiter, like materials.
    reportExcessChatMarkers(body, errors);
  } catch (error) {
    errors.push(`problem.md: invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  const parsed = problemFrontmatterSchema.safeParse(attributes);
  if (!parsed.success) {
    errors.push(...formatZodIssues(parsed.error, 'problem.md frontmatter'));
    return undefined;
  }
  return parsed.data;
}

async function readFileTestCases(
  problemDirectoryPath: string,
  { hasCustomJudgeTs, requiresExpectedOutput }: { hasCustomJudgeTs: boolean; requiresExpectedOutput: boolean },
  errors: string[],
  warnings: string[]
): Promise<FileTestCase[]> {
  const testCasesDirectoryPath = join(problemDirectoryPath, 'test_cases');
  if (!(await isDirectory(testCasesDirectoryPath))) return [];

  const dirents = await readdir(testCasesDirectoryPath, { withFileTypes: true });
  const idToTestCase = new Map<string, FileTestCase>();
  const getTestCase = (testCaseId: string): FileTestCase => {
    let testCase = idToTestCase.get(testCaseId);
    if (!testCase) {
      testCase = {
        id: testCaseId,
        hasFileInput: false,
        hasFileOutput: false,
        hasJudgeConfig: false,
      };
      idToTestCase.set(testCaseId, testCase);
    }
    return testCase;
  };
  for (const dirent of dirents.toSorted((d1, d2) => d1.name.localeCompare(d2.name))) {
    // Symbolic links were already reported for the whole problem directory.
    if (dirent.isSymbolicLink()) continue;
    // `_shared` is reserved: only `_shared.fin/` (a directory of inputs copied for every case) exists.
    if (dirent.name === SHARED_FILE_INPUT_NAME || dirent.name.startsWith(`${SHARED_FILE_INPUT_NAME}.`)) {
      if (dirent.name !== `${SHARED_FILE_INPUT_NAME}.fin`) {
        errors.push(`test_cases/${dirent.name} is not supported; only _shared.fin/ is shared across test cases`);
      } else if (!dirent.isDirectory()) {
        errors.push(`test_cases/${dirent.name} must be a directory`);
      } else {
        const sharedFilePaths = await listFilesRecursively(join(testCasesDirectoryPath, dirent.name));
        if (sharedFilePaths.length === 0) {
          errors.push(`test_cases/${dirent.name}/ is empty; put at least one shared input file in it`);
        }
      }
      continue;
    }
    const testCaseId = dirent.name.replace(/\.(fin|fout)$/, '');
    if (testCaseId === '') {
      errors.push(`test_cases/${dirent.name} must have a test case ID before its extension`);
      continue;
    }
    if (testCaseId === dirent.name) {
      // A directory named like a file entry is a wrong-typed entry, not an ignorable stranger.
      if (dirent.isDirectory() && /\.(in|out|json)$/.test(dirent.name)) {
        errors.push(`test_cases/${dirent.name} must be a file, not a directory`);
      }
      continue;
    }
    if (!dirent.isDirectory()) {
      errors.push(`test case ${testCaseId}: test_cases/${dirent.name} must be a directory`);
      continue;
    }
    // git does not track an empty directory, so an empty `.fin/` or `.fout/` would silently vanish on
    // commit, and the importer counts only real files that are not generated artifacts (an empty
    // subdirectory does not count); such a directory is an error and does not make the id a test case.
    const filePaths = await listFilesRecursively(join(testCasesDirectoryPath, dirent.name));
    if (filePaths.length === 0) {
      errors.push(`test case ${testCaseId}: ${dirent.name}/ is empty; put at least one file in it or delete it`);
      continue;
    }
    const testCase = getTestCase(testCaseId);
    if (dirent.name.endsWith('.fin')) {
      testCase.hasFileInput = true;
      continue;
    }
    testCase.hasFileOutput = true;
    // The importer keeps a placeholder like any file, so the stdio judge would require the program to write it.
    for (const filePath of filePaths) {
      if (basename(filePath) === '.gitkeep') {
        warnings.push(
          `test case ${testCaseId}: ${dirent.name}/${relative(join(testCasesDirectoryPath, dirent.name), filePath)} is compared as an expected output file; delete the placeholder`
        );
      }
    }
    // The stdio judge compares each expected file and refuses one above its limit (the importer rejects
    // the problem); a custom judge.ts reads the directory under its own contract.
    if (!hasCustomJudgeTs) {
      for (const filePath of filePaths) {
        const fileStats = await stat(filePath);
        if (fileStats.size > MAX_COMPARED_FILE_BYTES) {
          errors.push(
            `test case ${testCaseId}: ${dirent.name}/${relative(join(testCasesDirectoryPath, dirent.name), filePath)} is larger than ${MAX_COMPARED_FILE_BYTES} bytes, which the stdio judge cannot compare`
          );
        }
      }
    }
  }
  // `_shared.*` files were already reported by the entry loop above.
  const fileNames = dirents
    .filter(
      (dirent) =>
        dirent.isFile() && /\.(in|out|json)$/.test(dirent.name) && !dirent.name.startsWith(`${SHARED_FILE_INPUT_NAME}.`)
    )
    .map((dirent) => dirent.name)
    .toSorted((f1, f2) => f1.localeCompare(f2));
  for (const fileName of fileNames) {
    const testCaseId = fileName.replace(/\.(in|out|json)$/, '');
    if (testCaseId === '') {
      errors.push(`test_cases/${fileName} must have a test case ID before its extension`);
      continue;
    }
    const testCase = getTestCase(testCaseId);
    const content = await readFile(join(testCasesDirectoryPath, fileName), 'utf8');
    if (fileName.endsWith('.in')) {
      testCase.stdin = content.trimEnd();
    } else if (fileName.endsWith('.out')) {
      testCase.stdout = content.trimEnd();
    } else {
      // The presets ignore `.json`; only a custom judge.ts reads it, with a shape of its own.
      testCase.hasJudgeConfig = true;
      if (!hasCustomJudgeTs) {
        errors.push(
          `test case ${testCaseId}: ${fileName} is configuration for a custom judge.ts, which this problem does not have`
        );
      }
      try {
        JSON.parse(content);
      } catch {
        errors.push(`test case ${testCaseId}: ${fileName} is not valid JSON`);
      }
    }
  }

  // Directories and files are read in separate passes, so sort for deterministic per-case diagnostics below
  // (the entry-level diagnostics above follow the entry-name order of their own passes).
  const testCases = [...idToTestCase.values()].toSorted((t1, t2) => t1.id.localeCompare(t2.id));
  // A custom judge defines its own contract (e.g. it renders an output file from the input and
  // ships `.in` only), but it usually treats every case alike, so a partial set of expectations
  // still hints at a forgotten file. Input is optional in every form, so nothing guesses at it.
  // `.json` is configuration, not an output expectation, so it neither counts nor is warned about.
  const hasAnyExpectedOutput = testCases.some(hasExpectedOutput);
  for (const testCase of testCases) {
    // An empty `.fout/` was already reported above and does not count as an expectation, so a case that
    // exists through another entry is also reported here. A `.json` case without judge.ts was already
    // rejected as unsupported configuration.
    if (!hasExpectedOutput(testCase) && !testCase.hasJudgeConfig) {
      // The default stdio harness rejects such a case, so it is an error without judge.ts.
      if (!hasCustomJudgeTs) {
        if (!requiresExpectedOutput) continue;
        errors.push(
          `test case ${testCase.id}: ${testCase.id}.out (or ${testCase.id}.fout/) is missing; a problem without judge.ts needs an expected output for every test case`
        );
      } else if (hasAnyExpectedOutput) {
        warnings.push(
          `test case ${testCase.id}: ${testCase.id}.out (or ${testCase.id}.fout/) is missing while other cases have one`
        );
      }
    }
    // The stdio judge rejects a run whose raw stdout exceeds the limit, so a longer expectation can
    // never match (a program may still print exactly the limit without a trailing newline).
    // A custom judge.ts reads `.out` under its own contract, so only the importer's limit applies to it.
    // The importer measures the trimmed expectation. The stdio judge measures the raw output a run
    // prints; a run matching a trimmed expectation prints at least that many characters (the token
    // comparison ignores trailing whitespace), so only a longer trimmed expectation is impossible.
    if (testCase.stdout !== undefined) {
      const maxStdoutLength = hasCustomJudgeTs ? IMPORTER_MAX_STDOUT_LENGTH : MAX_STDOUT_LENGTH;
      if (testCase.stdout.length > maxStdoutLength) {
        errors.push(
          hasCustomJudgeTs
            ? `test case ${testCase.id}: .out is too large (length: ${testCase.stdout.length} > ${maxStdoutLength})`
            : `test case ${testCase.id}: .out is too large (length: ${testCase.stdout.length}); the stdio judge rejects a run that prints more than ${maxStdoutLength} characters`
        );
      }
    }
    // The judge accepts an empty `.out` (the program must print nothing or an empty line), but it is
    // usually a stray file of a case whose stdout is not compared.
    if (testCase.stdout !== undefined && testCase.stdout.length === 0) {
      warnings.push(
        `test case ${testCase.id}: .out is empty, so only a program that prints nothing (or an empty line) is accepted; delete .out when stdout is not compared`
      );
    }
  }

  // Only stdin is compared: a case with input files may legitimately share its stdin with others,
  // and file contents are not compared for duplicates.
  const stdinToFirstId = new Map<string, string>();
  for (const testCase of testCases) {
    // An empty `.in` means "no input" (like an absent one) and is not a duplicate of another empty one.
    if (!testCase.stdin || testCase.hasFileInput) continue;
    const firstId = stdinToFirstId.get(testCase.stdin);
    if (firstId === undefined) {
      stdinToFirstId.set(testCase.stdin, testCase.id);
    } else {
      warnings.push(`test cases ${firstId} and ${testCase.id} have identical input`);
    }
  }
  return testCases;
}

async function listSymbolicLinks(directoryPath: string): Promise<string[]> {
  const linkPaths: string[] = [];
  for (const dirent of await readdir(directoryPath, { withFileTypes: true })) {
    const entryPath = join(directoryPath, dirent.name);
    if (dirent.isSymbolicLink()) {
      linkPaths.push(entryPath);
    } else if (dirent.isDirectory() && dirent.name !== 'node_modules') {
      linkPaths.push(...(await listSymbolicLinks(entryPath)));
    }
  }
  return linkPaths.toSorted((p1, p2) => p1.localeCompare(p2));
}

/** Lists the real files under a test case directory, leaving out generated artifacts like the importer. */
async function listFilesRecursively(directoryPath: string): Promise<string[]> {
  const filePaths: string[] = [];
  for (const dirent of await readdir(directoryPath, { withFileTypes: true })) {
    if (IGNORED_TEST_CASE_ENTRY_NAMES.has(dirent.name)) continue;
    const entryPath = join(directoryPath, dirent.name);
    if (dirent.isFile()) {
      filePaths.push(entryPath);
    } else if (dirent.isDirectory()) {
      filePaths.push(...(await listFilesRecursively(entryPath)));
    }
  }
  return filePaths;
}

function hasExpectedOutput(testCase: FileTestCase): boolean {
  return testCase.stdout !== undefined || testCase.hasFileOutput;
}

function validateTestCasePresence(
  frontmatter: ProblemFrontmatter | undefined,
  fileTestCases: FileTestCase[],
  hasCustomJudgeTs: boolean,
  errors: string[],
  warnings: string[]
): void {
  // Exercode's import requires test cases, a judge.ts or isManualScoringRequired and grants no
  // exemption for `type: prompt_study` or static-analysis rules (this package's `judge` subcommand
  // runs a rules-only problem, but it cannot be imported).
  if (fileTestCases.length === 0 && frontmatter?.isManualScoringRequired !== true) {
    // The judge only rejects a case-less problem when judge.ts is also missing; a special judge
    // may compute results itself, but the stdio presets need test_cases/, hence the warning.
    if (hasCustomJudgeTs) {
      warnings.push(
        'no test cases found; fine for a special judge, but stdio-preset judges require an expected output (test_cases/<id>.out or <id>.fout/) for every case'
      );
    } else {
      errors.push(
        'no test cases found; add test cases with an expected output (test_cases/<id>.out or <id>.fout/, plus <id>.in or <id>.fin/ when the program reads input; at least one example_* and one hidden test_*), or set isManualScoringRequired: true'
      );
    }
  }
  if (fileTestCases.length > 0) {
    reportTestCaseCompositionIssues(fileTestCases, errors, warnings);
  }
}

function reportTestCaseCompositionIssues(
  testCases: readonly { id: string }[],
  errors: string[],
  warnings: string[]
): void {
  if (!testCases.some((testCase) => EXAMPLE_TEST_CASE_ID_PATTERN.test(testCase.id))) {
    errors.push('no example test case found; add at least one test case whose ID contains "example" (e.g. example_1)');
  }
  if (testCases.every((testCase) => EXAMPLE_TEST_CASE_ID_PATTERN.test(testCase.id))) {
    errors.push(
      'no hidden test case found; add at least one test case whose ID does not contain "example" (e.g. test_1)'
    );
  }
  if (testCases.length < RECOMMENDED_MIN_TEST_CASE_COUNT) {
    warnings.push(
      `only ${testCases.length} test cases found; ${RECOMMENDED_MIN_TEST_CASE_COUNT} or more are recommended`
    );
  }
}

async function readModelAnswers(
  problemDirectoryPath: string,
  errors: string[],
  warnings: string[]
): Promise<ModelAnswer[]> {
  const modelAnswersDirectoryPath = join(problemDirectoryPath, 'model_answers');
  if (!(await isDirectory(modelAnswersDirectoryPath))) return [];

  const modelAnswers: ModelAnswer[] = [];
  const dirents = await readdir(modelAnswersDirectoryPath, { withFileTypes: true });
  for (const dirent of dirents.toSorted((d1, d2) => d1.name.localeCompare(d2.name))) {
    if (!dirent.isDirectory() || dirent.name === '__pycache__') continue;
    // The judge parses each directory name with learningMaterialIdSchema, so a regex-invalid
    // name (e.g. "Python") aborts import, while an unknown but valid ID (e.g. "foo") imports fine.
    if (!LEARNING_MATERIAL_ID_REGEX.test(dirent.name)) {
      errors.push(`model answer directory name "${dirent.name}" must match ${LEARNING_MATERIAL_ID_REGEX}`);
      continue;
    }
    if (!(availableLanguageIds as readonly string[]).includes(dirent.name)) {
      warnings.push(
        `model answer directory name "${dirent.name}" is not a known language ID (${availableLanguageIds.join(', ')})`
      );
    }
    const files = await readSourceFilesRecursively(join(modelAnswersDirectoryPath, dirent.name));
    // The all-problem check judges every model answer directory, so an empty one fails there.
    if (files.length === 0) {
      errors.push(`model answer directory "${dirent.name}" has no source files; add files or delete it`);
      continue;
    }
    modelAnswers.push({ id: dirent.name, files });
  }
  return modelAnswers;
}

function validateCodePatterns(
  frontmatter: ProblemFrontmatter,
  modelAnswers: ModelAnswer[],
  errors: string[],
  warnings: string[]
): void {
  const requiredRegExps = compilePatterns(frontmatter.requiredRegExpsInCode, 'requiredRegExpsInCode', errors);
  const forbiddenRegExps = compilePatterns(frontmatter.forbiddenRegExpsInCode, 'forbiddenRegExpsInCode', errors);
  const forbiddenTexts = frontmatter.forbiddenTextsInCode.map((rule) => normalizeCodeRule(rule).pattern);

  for (const [pattern, regExp] of forbiddenRegExps) {
    if (PARSING_CODE_SNIPPETS.some((snippet) => regExp.test(snippet))) {
      warnings.push(
        `forbiddenRegExpsInCode pattern "${pattern}" matches typical stdin-parsing code; patterns must not restrict parsing helpers (${ALLOWED_PARSING_HELPERS.join(', ')})`
      );
    }
  }
  for (const text of forbiddenTexts) {
    if (PARSING_CODE_SNIPPETS.some((snippet) => snippet.includes(text))) {
      warnings.push(
        `forbiddenTextsInCode text "${text}" appears in typical stdin-parsing code; texts must not restrict parsing helpers (${ALLOWED_PARSING_HELPERS.join(', ')})`
      );
    }
  }

  for (const modelAnswer of modelAnswers) {
    const strippedFiles = readSourceCodeWithoutComments(modelAnswer.files);

    for (const [pattern, regExp] of requiredRegExps) {
      if (!strippedFiles.some((file) => regExp.test(file.data))) {
        errors.push(
          `required pattern "${pattern}" does not match any file of model answer "${modelAnswer.id}" (comments are ignored)`
        );
      }
    }
    for (const [pattern, regExp] of forbiddenRegExps) {
      for (const file of strippedFiles) {
        const matched = file.data.match(regExp);
        if (matched) {
          errors.push(
            `forbidden pattern "${pattern}" matches model answer file ${modelAnswer.id}/${file.path} (matched "${matched[0]}")`
          );
        }
      }
    }
    for (const forbiddenText of forbiddenTexts) {
      for (const file of strippedFiles) {
        if (file.data.includes(forbiddenText)) {
          errors.push(`forbidden text "${forbiddenText}" appears in model answer file ${modelAnswer.id}/${file.path}`);
        }
      }
    }
  }
}

/**
 * The judge rejects a submission missing a required file before running it, so every model answer
 * must ship them among the files the importer keeps (the same filter as `readSourceFilesRecursively`).
 */
function validateRequiredSubmissionFiles(
  frontmatter: ProblemFrontmatter,
  modelAnswers: ModelAnswer[],
  errors: string[]
): void {
  for (const modelAnswer of modelAnswers) {
    const filePathSet = new Set(modelAnswer.files.map((file) => file.path));
    for (const requiredPath of frontmatter.requiredSubmissionFilePaths) {
      if (!filePathSet.has(requiredPath)) {
        errors.push(
          `required submission file "${requiredPath}" is missing from model answer "${modelAnswer.id}" (requiredSubmissionFilePaths)`
        );
      }
    }
  }
}

/** Selects and strips the files exactly like the judge's static analysis of a submission does. */
function readSourceCodeWithoutComments(files: SourceFile[]): SourceFile[] {
  return files.flatMap((file) => {
    const languageDefinition = findLanguageDefinitionByPath(file.path);
    if (!languageDefinition || file.data.includes('\uFFFD')) return [];
    const grammar = languageDefinition.grammer;
    return [{ path: file.path, data: grammar ? removeCommentsInSourceCode(grammar, file.data) : file.data }];
  });
}

function compilePatterns(rules: CodeRule[], fieldName: string, errors: string[]): [string, RegExp][] {
  const compiled: [string, RegExp][] = [];
  for (const rule of rules) {
    const { pattern } = normalizeCodeRule(rule);
    try {
      compiled.push([pattern, new RegExp(pattern)]);
    } catch {
      errors.push(`invalid regular expression in ${fieldName}: ${pattern}`);
    }
  }
  return compiled;
}

async function validateTemplates(
  problemDirectoryPath: string,
  modelAnswers: ModelAnswer[],
  hasCustomJudgeTs: boolean,
  errors: string[],
  warnings: string[]
): Promise<void> {
  const templatesDirectoryPath = join(problemDirectoryPath, 'templates');
  if (!(await isDirectory(templatesDirectoryPath))) return;

  const dirents = await readdir(templatesDirectoryPath, { withFileTypes: true });
  // The judge only skips __pycache__; a stray .DS_Store next to template directories fails
  // import as a mixed files-and-directories layout, so it must not be filtered out here.
  const entries = dirents.filter((dirent) => dirent.name !== '__pycache__');
  if (entries.some((dirent) => dirent.name === '.DS_Store')) {
    warnings.push('templates/.DS_Store found; delete it (the judge treats it as a template file)');
  }
  // The importer accepts only regular files and directories under templates/.
  for (const dirent of entries) {
    if (!dirent.isFile() && !dirent.isDirectory()) {
      errors.push(`templates/${dirent.name} must be a regular file or directory (symbolic links fail import)`);
    }
  }
  const hasFiles = entries.some((dirent) => dirent.isFile());
  const hasDirectories = entries.some((dirent) => dirent.isDirectory());
  if (hasFiles && hasDirectories) {
    errors.push(
      'templates directory must not contain both files and directories; use templates/<languageId>/ or templates/_default/ (or plain files as the default)'
    );
    return;
  }
  for (const dirent of entries) {
    if (
      dirent.isDirectory() &&
      dirent.name !== '_default' &&
      !(availableLanguageIds as readonly string[]).includes(dirent.name)
    ) {
      errors.push(
        `invalid template directory name "${dirent.name}"; expected a language ID (${availableLanguageIds.join(', ')}) or _default`
      );
    }
  }
  // A template must be an incomplete starting point: a template directory that carries every file
  // a model answer is judged by, unchanged, would pass the judge. The stdio judge runs the source
  // files of a supported language (notes next to the answer do not change what runs), while a
  // custom judge.ts may read any file (e.g. a CSV submission). Helper modules shared by both are fine.
  const directoryNames = entries.filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name);
  const templateDirectoryNames = hasDirectories ? directoryNames : [''];
  for (const templateDirectoryName of templateDirectoryNames) {
    const templateFiles = await readSourceFilesRecursively(join(templatesDirectoryPath, templateDirectoryName));
    const templateContentByPath = new Map(templateFiles.map((file) => [file.path, file.data]));
    for (const modelAnswer of modelAnswers) {
      const judgedFiles = modelAnswer.files.filter(
        (file) =>
          file.data.trim().length > 0 && (hasCustomJudgeTs || findLanguageDefinitionByPath(file.path) !== undefined)
      );
      if (judgedFiles.length > 0 && judgedFiles.every((file) => templateContentByPath.get(file.path) === file.data)) {
        warnings.push(
          `templates/${templateDirectoryName} contains every judged file of model answer "${modelAnswer.id}" unchanged (identical to a model answer file); templates must not pass the judge`
        );
      }
    }
  }
}
