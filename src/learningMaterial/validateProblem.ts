import { readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { HARNESS_FILE_PRESETS, isDefaultStdioHarnessSource } from '../helpers/defaultStdioHarness.js';
import { findLanguageDefinitionByPath } from '../helpers/findLanguageDefinitionByPath.js';
import { removeCommentsInSourceCode } from '../helpers/removeCommentsInSourceCode.js';
import { type CodeRule, normalizeCodeRule } from '../types/problem.js';

import { parseFrontmatter } from './frontmatter.js';
import { isDirectory, isFile, readSourceFilesRecursively, type SourceFile } from './fsHelpers.js';
import {
  availableLanguageIds,
  LEARNING_MATERIAL_ID_REGEX,
  problemFrontmatterSchema,
  type ProblemFrontmatter,
} from './schemas.js';
import { reportExcessChatMarkers } from './validateMaterial.js';
import { formatZodIssues, type ValidationResult } from './validationResult.js';

// Same pattern the judge uses to decide which test cases appear on the problem page.
const EXAMPLE_TEST_CASE_ID_REGEX = /(\d+_)?example(_\d+)?/;
const MAX_STDOUT_LENGTH = 100_000;
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

// `_shared.fin/` holds files copied for every test case; it is not a test case itself.
const SHARED_FILE_INPUT_NAME = '_shared';
// A directory holding only these is as good as empty: `.DS_Store` is ignored by git and `.gitkeep` is a placeholder.
const PLACEHOLDER_FILE_NAMES: ReadonlySet<string> = new Set(['.DS_Store', '.gitkeep']);

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
  if (!(await isDirectory(absoluteDirectoryPath))) {
    errors.push(`problem directory not found: ${problemDirectoryPath}`);
    return result;
  }

  const problemId = basename(absoluteDirectoryPath);
  if (!LEARNING_MATERIAL_ID_REGEX.test(problemId)) {
    errors.push(`problem ID "${problemId}" (directory name) must match ${LEARNING_MATERIAL_ID_REGEX}`);
  }
  if (await isFile(join(absoluteDirectoryPath, `${problemId}.problem.md`))) {
    errors.push(
      `found v1 problem file ${problemId}.problem.md; use the v2 layout with a file named exactly problem.md`
    );
  }

  const problemFilePath = join(absoluteDirectoryPath, 'problem.md');
  if (!(await isFile(problemFilePath))) {
    errors.push('problem.md not found; a v2 problem directory must contain problem.md');
    return result;
  }

  const frontmatter = await parseProblemFrontmatter(problemFilePath, errors);
  const harness = await readHarnessFiles(absoluteDirectoryPath);
  // The stdio judge compares outputs unless the front matter judges every test case otherwise
  // (manual scoring or the presence of required output files); code rules and required submission
  // files check the submission once and only add to the comparison.
  const requiresExpectedOutput =
    frontmatter === undefined ||
    (frontmatter.isManualScoringRequired !== true && frontmatter.requiredOutputFilePaths.length === 0);
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

  const hasSolutionDirectory = await isDirectory(join(absoluteDirectoryPath, 'solution'));
  const modelAnswers = await readModelAnswers(absoluteDirectoryPath, errors, warnings);
  // An empty solution/ directory or whitespace-only files still produce entries, so presence
  // requires at least one non-empty source file rather than a non-empty answer list.
  const usableModelAnswers = modelAnswers.filter((answer) => answer.files.some((file) => file.data.trim().length > 0));
  if (usableModelAnswers.length === 0 && isScoredAutomatically) {
    // solution/ shadows model_answers/ in the judge, so "add model_answers/" would be unactionable then.
    errors.push(
      hasSolutionDirectory
        ? 'solution/ exists but has no non-empty source files; add files under solution/ or remove it to use model_answers/'
        : 'no model answers found; add at least one model_answers/<languageId>/ directory with non-empty source files'
    );
  }
  if (frontmatter) {
    validateCodePatterns(frontmatter, usableModelAnswers, errors, warnings);
  }
  await validateTemplates(absoluteDirectoryPath, usableModelAnswers, errors, warnings);

  return result;
}

interface HarnessFiles {
  hasDebugTs: boolean;
  hasDefaultJudgeTs: boolean;
  hasDefaultDebugTs: boolean;
  hasCustomJudgeTs: boolean;
}

async function readHarnessFiles(absoluteDirectoryPath: string): Promise<HarnessFiles> {
  const judgeTsPath = join(absoluteDirectoryPath, 'judge.ts');
  const debugTsPath = join(absoluteDirectoryPath, 'debug.ts');
  const hasJudgeTs = await isFile(judgeTsPath);
  const hasDebugTs = await isFile(debugTsPath);
  const hasDefaultJudgeTs =
    hasJudgeTs && isDefaultStdioHarnessSource(await readFile(judgeTsPath, 'utf8'), HARNESS_FILE_PRESETS['judge.ts']);
  const hasDefaultDebugTs =
    hasDebugTs && isDefaultStdioHarnessSource(await readFile(debugTsPath, 'utf8'), HARNESS_FILE_PRESETS['debug.ts']);
  return {
    hasDebugTs,
    hasDefaultJudgeTs,
    hasDefaultDebugTs,
    hasCustomJudgeTs: hasJudgeTs && !hasDefaultJudgeTs,
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
  if (harness.hasDefaultJudgeTs) {
    errors.push(
      'judge.ts only calls stdioJudgePreset; delete it — the judge auto-generates it, and only a problem without judge.ts is treated as a standard stdio problem (which enables the default debug runner)'
    );
  }
  // A custom judge.ts may legitimately reuse the stdio debug preset, so a default debug.ts is
  // redundant only when the judge.ts is absent or itself default (i.e. about to be deleted).
  if (harness.hasDefaultDebugTs && !harness.hasCustomJudgeTs) {
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
    // The judge readers enumerate real files and directories only, so a symlink would be ignored at judge time.
    if (dirent.isSymbolicLink() && /\.(in|out|json|fin|fout)$/.test(dirent.name)) {
      errors.push(
        `test_cases/${dirent.name} is a symbolic link, which the judge ignores; commit a real file or directory`
      );
      continue;
    }
    // `_shared` is reserved: only `_shared.fin/` (a directory of inputs copied for every case) exists.
    if (dirent.name === SHARED_FILE_INPUT_NAME || dirent.name.startsWith(`${SHARED_FILE_INPUT_NAME}.`)) {
      if (dirent.name !== `${SHARED_FILE_INPUT_NAME}.fin`) {
        errors.push(`test_cases/${dirent.name} is not supported; only _shared.fin/ is shared across test cases`);
      } else if (!dirent.isDirectory()) {
        errors.push(`test_cases/${dirent.name} must be a directory`);
      } else {
        if (!(await hasEntries(join(testCasesDirectoryPath, dirent.name)))) {
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
    // commit; it is an error and does not make the id a test case. Only the top level is listed: any entry
    // (file, symlink or subdirectory) other than a placeholder counts, and no tree is walked, so a symlink
    // cycle inside cannot break validation.
    if (!(await hasEntries(join(testCasesDirectoryPath, dirent.name)))) {
      errors.push(`test case ${testCaseId}: ${dirent.name}/ is empty; put at least one file in it or delete it`);
      continue;
    }
    const testCase = getTestCase(testCaseId);
    if (dirent.name.endsWith('.fin')) {
      testCase.hasFileInput = true;
    } else {
      testCase.hasFileOutput = true;
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
    if (testCase.stdout !== undefined && testCase.stdout.length > MAX_STDOUT_LENGTH) {
      errors.push(
        `test case ${testCase.id}: .out is too large (length: ${testCase.stdout.length} > ${MAX_STDOUT_LENGTH})`
      );
    }
    // An empty `.out` is either a program that prints nothing (forbidden by the authoring rules) or a
    // stray file of a case whose stdout is not compared; both are authoring mistakes.
    if (testCase.stdout !== undefined && testCase.stdout.length === 0) {
      errors.push(
        `test case ${testCase.id}: .out is empty; make the program print something, or delete .out when stdout is not compared`
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

async function hasEntries(directoryPath: string): Promise<boolean> {
  const entryNames = await readdir(directoryPath);
  return entryNames.some((name) => !PLACEHOLDER_FILE_NAMES.has(name));
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
  // The judge requires isManualScoringRequired for case-less problems without judge.ts and grants
  // no exemption for `type: prompt_study`, so the type must not relax this check.
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
  if (!testCases.some((testCase) => EXAMPLE_TEST_CASE_ID_REGEX.test(testCase.id))) {
    errors.push(
      'no example test case found; add at least one test case whose ID starts with "example" (e.g. example_1)'
    );
  }
  if (testCases.every((testCase) => EXAMPLE_TEST_CASE_ID_REGEX.test(testCase.id))) {
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
  // Special judges keep the single model answer in `solution/`; the judge ignores model_answers/ then.
  const solutionDirectoryPath = join(problemDirectoryPath, 'solution');
  if (await isDirectory(solutionDirectoryPath)) {
    if (await isDirectory(join(problemDirectoryPath, 'model_answers'))) {
      warnings.push(
        'both solution/ and model_answers/ exist; the judge ignores model_answers/ when solution/ is present'
      );
    }
    return [{ id: 'default', files: await readSourceFilesRecursively(solutionDirectoryPath) }];
  }

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
    if (files.length > 0) modelAnswers.push({ id: dirent.name, files });
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
  // The judge special-cases templates/_default/ only when it is alone; with siblings it parses
  // every directory name as a language ID and fails on "_default", so a mixed layout cannot import.
  const directoryNames = entries.filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name);
  if (directoryNames.includes('_default') && directoryNames.length > 1) {
    errors.push('templates/_default/ cannot be mixed with language-ID template directories; use one layout');
  }

  // A template must be an incomplete starting point; a byte-identical copy of a model answer would pass the judge.
  const modelAnswerFileContents = new Set(modelAnswers.flatMap((answer) => answer.files.map((file) => file.data)));
  const templateFiles = await readSourceFilesRecursively(templatesDirectoryPath);
  for (const templateFile of templateFiles) {
    if (modelAnswerFileContents.has(templateFile.data)) {
      warnings.push(
        `template file templates/${templateFile.path} is identical to a model answer file; templates must not pass the judge`
      );
    }
  }
}
