import child_process from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';

import { copyProblemDirToTemporaryRoot } from '../helpers/checkProblemDirIsolation.js';
import { findDefaultStdioHarnessFiles } from '../helpers/defaultStdioHarness.js';
import { findFailingModelAnswerDirs, findModelAnswerDirs } from '../helpers/findModelAnswerDirs.js';
import { readTestCases } from '../helpers/readTestCases.js';
import { DecisionCode } from '../types/decisionCode.js';
import { TEST_CASE_RESULT_PREFIX, testCaseResultSchema } from '../types/testCaseResult.js';

import { formatDefaultHarnessError } from './runSingleHarness.js';

const execFileAsync = util.promisify(child_process.execFile);

const RUN_TIMEOUT_MS = 600_000;
const MAX_RUN_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_FAILURE_DETAIL_LENGTH = 1000;

const decisionCodeNames = new Map<number, string>(Object.entries(DecisionCode).map(([name, code]) => [code, name]));

interface CheckOptions {
  rootDir: string;
  concurrency: number;
  only: string[];
  skip: string[];
}

interface CheckRun {
  problemDir: string;
  answerDir: string;
  /** Whether all test cases must be accepted (`model_answers`) or at least one must fail (`model_answers.fails`). */
  expectation: 'accepted' | 'rejected';
}

/**
 * Judge all model answers of all problems (directories containing `problem.md` or
 * `<id>.problem.md`) under a root directory: `model_answers/*` must be fully accepted and
 * `model_answers.fails/*` must fail at least one test case. Returns the process exit code.
 */
export async function checkAllProblems(args: readonly string[]): Promise<number> {
  const options = parseCheckArgs(args);
  const rootDir = path.resolve(options.rootDir);
  const toRelative = (dir: string): string => path.relative(rootDir, dir) || '.';

  const allProblemDirs = await findProblemDirs(rootDir);
  const problemDirs = allProblemDirs.filter((problemDir) => {
    const relativeDir = toRelative(problemDir);
    if (options.only.length > 0 && !options.only.some((substring) => relativeDir.includes(substring))) return false;
    return !options.skip.some((substring) => relativeDir.includes(substring));
  });
  if (problemDirs.length === 0) {
    console.error(
      allProblemDirs.length === 0
        ? `No problem directories (containing problem.md or <id>.problem.md) found under ${rootDir}.`
        : `All ${allProblemDirs.length} problem directories under ${rootDir} were excluded by --only/--skip.`
    );
    return 1;
  }

  const failures: string[] = [];
  const runs: CheckRun[] = [];
  for (const problemDir of problemDirs) {
    const defaultHarnessFileNames = await findDefaultStdioHarnessFiles(problemDir);
    if (defaultHarnessFileNames.length > 0) {
      failures.push(`${toRelative(problemDir)}: ${formatDefaultHarnessError(defaultHarnessFileNames)}`);
      continue;
    }

    const modelAnswerDirs = await findModelAnswerDirs(problemDir);
    if (modelAnswerDirs.length === 0) {
      failures.push(`${toRelative(problemDir)}: no model answers found under model_answers/`);
      continue;
    }

    // Without test cases, stdioJudgePreset prints a single accepted sentinel result, so a standard
    // problem with an empty or missing test_cases/ would otherwise pass without being judged.
    if (!(await fileExists(path.join(problemDir, 'judge.ts')))) {
      const testCases = await readTestCases(path.join(problemDir, 'test_cases'));
      if (testCases.length === 0) {
        failures.push(
          `${toRelative(problemDir)}: a standard stdio problem (without judge.ts) needs at least one test case under test_cases/`
        );
        continue;
      }
    }

    const failingModelAnswerDirs = await findFailingModelAnswerDirs(problemDir);
    runs.push(
      ...modelAnswerDirs.map((answerDir): CheckRun => ({ problemDir, answerDir, expectation: 'accepted' })),
      ...failingModelAnswerDirs.map((answerDir): CheckRun => ({ problemDir, answerDir, expectation: 'rejected' }))
    );
  }
  for (const failure of failures) console.error(`✗ ${failure}`);

  const cliEntryPath = path.resolve(process.argv[1] ?? '');
  let passedCount = 0;
  let nextRunIndex = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(options.concurrency, runs.length)) }, async () => {
      while (nextRunIndex < runs.length) {
        const run = runs[nextRunIndex++];
        if (!run) return;
        const label = `${toRelative(run.problemDir)} ${path.relative(run.problemDir, run.answerDir)}`;
        const failureDetail = await executeCheckRun(run, cliEntryPath);
        if (failureDetail === undefined) {
          passedCount++;
          console.info(`✓ ${label}`);
        } else {
          failures.push(`${label}: ${failureDetail}`);
          console.error(`✗ ${label}: ${failureDetail}`);
        }
      }
    })
  );

  console.info(
    `\n${passedCount} passed, ${failures.length} failed (${runs.length} runs, ${problemDirs.length} problems)`
  );
  return failures.length === 0 ? 0 : 1;
}

/**
 * Run one answer directory through the problem's harness and return a failure detail, if any.
 * The problem directory is copied to a temporary location first so that judging (e.g. build
 * artifacts in answer directories) never modifies the checked repository.
 */
async function executeCheckRun(run: CheckRun, cliEntryPath: string): Promise<string | undefined> {
  let stdout = '';
  let stderr = '';
  let exitCode: number | undefined = 0;
  let errorCode: string | undefined;
  let timedOut = false;
  let tempRoot: string;
  let copiedProblemDir: string;
  try {
    ({ tempRoot, copiedProblemDir } = await copyProblemDirToTemporaryRoot(run.problemDir));
  } catch (error) {
    return truncate(
      `failed to copy the problem directory to a temporary location: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  try {
    ({ stdout, stderr } = await execFileAsync(
      'bun',
      ['run', cliEntryPath, path.relative(run.problemDir, run.answerDir)],
      { cwd: copiedProblemDir, encoding: 'utf8', maxBuffer: MAX_RUN_OUTPUT_BYTES, timeout: RUN_TIMEOUT_MS }
    ));
  } catch (error) {
    const execError = error as child_process.ExecFileException & { stdout?: string; stderr?: string };
    stdout = execError.stdout ?? '';
    stderr = execError.stderr ?? '';
    exitCode = typeof execError.code === 'number' ? execError.code : undefined;
    errorCode = typeof execError.code === 'string' ? execError.code : undefined;
    timedOut = execError.killed === true && errorCode === undefined;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }

  if (timedOut) return `timed out after ${RUN_TIMEOUT_MS / 1000} seconds`;
  if (errorCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return `the harness printed more than ${MAX_RUN_OUTPUT_BYTES / 1024 / 1024} MB of output`;
  }
  if (errorCode !== undefined) return truncate(`failed to run the harness: ${errorCode}`);
  if (exitCode !== 0) {
    return truncate(`harness exited with ${exitCode ?? 'a signal'}${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
  }

  const resultLines = stdout.split('\n').filter((line) => line.startsWith(TEST_CASE_RESULT_PREFIX));
  const testCaseResults = [];
  for (const line of resultLines) {
    let parsedResult;
    try {
      parsedResult = testCaseResultSchema.safeParse(JSON.parse(line.slice(TEST_CASE_RESULT_PREFIX.length)));
    } catch {
      parsedResult = undefined;
    }
    if (!parsedResult?.success) return truncate(`malformed test case result line: ${line}`);
    testCaseResults.push(parsedResult.data);
  }
  if (testCaseResults.length === 0) return 'no test case results were printed';

  if (run.expectation === 'accepted') {
    const rejectedResult = testCaseResults.find((result) => result.decisionCode !== DecisionCode.ACCEPTED);
    if (rejectedResult) {
      return truncate(
        `${decisionCodeNames.get(rejectedResult.decisionCode) ?? rejectedResult.decisionCode} on test case ${rejectedResult.testCaseId}${rejectedResult.stderr?.trim() ? `: ${rejectedResult.stderr.trim()}` : ''}`
      );
    }
    return undefined;
  }
  return testCaseResults.every((result) => result.decisionCode === DecisionCode.ACCEPTED)
    ? 'expected at least one failing test case, but all test cases were accepted'
    : undefined;
}

function parseCheckArgs(args: readonly string[]): CheckOptions {
  const options: CheckOptions = {
    rootDir: '.',
    concurrency: Math.max(1, Math.min(4, os.availableParallelism())),
    only: [],
    skip: [],
  };
  let hasRootDir = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) break;
    if (arg === '--concurrency' || arg === '--only' || arg === '--skip') {
      const value = args[++index];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      if (arg === '--concurrency') {
        options.concurrency = Number(value);
        if (!Number.isInteger(options.concurrency) || options.concurrency <= 0) {
          throw new Error(`--concurrency requires a positive integer, but got ${value}`);
        }
      } else if (arg === '--only') {
        options.only.push(value);
      } else {
        options.skip.push(value);
      }
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (hasRootDir) {
      throw new Error(`Only one root directory can be specified, but got both ${options.rootDir} and ${arg}`);
    } else {
      options.rootDir = arg;
      hasRootDir = true;
    }
  }
  return options;
}

/** Find directories containing `problem.md` or `<id>.problem.md`, without descending into found problems. */
async function findProblemDirs(rootDir: string): Promise<string[]> {
  const problemDirs: string[] = [];
  await visitDirectory(rootDir, problemDirs);
  return problemDirs.toSorted();
}

async function visitDirectory(dir: string, problemDirs: string[]): Promise<void> {
  // Traversal errors (e.g. an unreadable subtree) must fail the check: skipping them silently
  // could report a green result while covering only part of the repository.
  const entries = await fs.readdir(dir, { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && (entry.name === 'problem.md' || entry.name.endsWith('.problem.md')))) {
    problemDirs.push(dir);
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    await visitDirectory(path.join(dir, entry.name), problemDirs);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function truncate(text: string): string {
  return text.length <= MAX_FAILURE_DETAIL_LENGTH ? text : `${text.slice(0, MAX_FAILURE_DETAIL_LENGTH)}...`;
}
