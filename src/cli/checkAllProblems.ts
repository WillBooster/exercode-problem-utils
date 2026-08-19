import child_process from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  copyProblemDirToTemporaryRoot,
  forciblyRemoveDirectory,
  forciblyRemoveDirectorySync,
} from '../helpers/checkProblemDirIsolation.js';
import { findDefaultStdioHarnessFiles } from '../helpers/defaultStdioHarness.js';
import { findFailingModelAnswerDirs, findModelAnswerDirs } from '../helpers/findModelAnswerDirs.js';
import { readTestCases } from '../helpers/readTestCases.js';
import { DecisionCode } from '../types/decisionCode.js';
import { TEST_CASE_RESULT_PREFIX, testCaseResultSchema } from '../types/testCaseResult.js';

import { formatDefaultHarnessError } from './runSingleHarness.js';

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
  // Normalize to forward slashes so --only / --skip substrings like courses/foo match on Windows.
  const toRelative = (dir: string): string => (path.relative(rootDir, dir) || '.').replaceAll(path.sep, '/');

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
        const label = `${toRelative(run.problemDir)} ${path.relative(run.problemDir, run.answerDir).replaceAll(path.sep, '/')}`;
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
  let tempRoot: string;
  let copiedProblemDir: string;
  try {
    ({ tempRoot, copiedProblemDir } = await copyProblemDirToTemporaryRoot(run.problemDir));
  } catch (error) {
    return truncate(
      `failed to copy the problem directory to a temporary location: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const result = await runHarnessProcess(
    ['run', cliEntryPath, 'judge', path.relative(run.problemDir, run.answerDir)],
    copiedProblemDir,
    tempRoot
  );
  const removedTempRoot = await forciblyRemoveDirectory(tempRoot);
  const harnessFailureDetail = summarizeHarnessFailure(run, result);
  if (removedTempRoot) return harnessFailureDetail;
  const removalFailureDetail = `failed to remove the temporary copy at ${tempRoot} (judged code may have left permission-locked files)`;
  return harnessFailureDetail === undefined
    ? removalFailureDetail
    : truncate(`${harnessFailureDetail}; ${removalFailureDetail}`);
}

/** Return why the harness run failed the check, or `undefined` when it passed. */
function summarizeHarnessFailure(run: CheckRun, result: HarnessProcessResult): string | undefined {
  const { stdout, stderr } = result;
  if (result.failureReason !== undefined) return truncate(result.failureReason);
  if (result.exitCode !== 0) {
    return truncate(`harness exited with ${result.exitCode ?? 'a signal'}${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
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

interface HarnessProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  failureReason: string | undefined;
}

interface LiveHarnessRun {
  pid: number;
  tempRoot: string;
}

// Detached harness groups no longer receive the terminal's SIGINT, so an interrupted check run must
// tear them down (and remove their temp copies) itself before exiting.
const liveHarnessRuns = new Set<LiveHarnessRun>();
let signalHandlersInstalled = false;

/**
 * Run the harness in its own process group, killing the whole group on timeout or when the output
 * cap is exceeded so grandchild submission processes cannot outlive the run.
 */
function runHarnessProcess(
  commandArgs: readonly string[],
  cwd: string,
  tempRoot: string
): Promise<HarnessProcessResult> {
  installSignalHandlers();
  return new Promise((resolve) => {
    const child = child_process.spawn('bun', commandArgs, {
      cwd,
      detached: process.platform !== 'win32',
      env: createHarnessEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const liveRun: LiveHarnessRun | undefined = child.pid === undefined ? undefined : { pid: child.pid, tempRoot };
    if (liveRun) liveHarnessRuns.add(liveRun);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalOutputBytes = 0;
    let failureReason: string | undefined;
    let settled = false;

    const killProcessGroup = (reason: string): void => {
      if (failureReason !== undefined) return;
      failureReason = reason;
      try {
        if (child.pid === undefined) {
          child.kill('SIGKILL');
        } else {
          killHarnessTree(child.pid);
        }
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timeoutId = setTimeout(
      () => killProcessGroup(`timed out after ${RUN_TIMEOUT_MS / 1000} seconds`),
      RUN_TIMEOUT_MS
    );

    const appendOutput = (chunk: Buffer, chunks: Buffer[]): void => {
      totalOutputBytes += chunk.byteLength;
      if (totalOutputBytes > MAX_RUN_OUTPUT_BYTES) {
        killProcessGroup(`the harness printed more than ${MAX_RUN_OUTPUT_BYTES / 1024 / 1024} MB of output`);
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => appendOutput(chunk, stdoutChunks));
    child.stderr.on('data', (chunk: Buffer) => appendOutput(chunk, stderrChunks));

    const settle = (exitCode: number | undefined, spawnError?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (liveRun) liveHarnessRuns.delete(liveRun);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode,
        failureReason: failureReason ?? (spawnError ? `failed to run the harness: ${spawnError.message}` : undefined),
      });
    };
    child.on('error', (error) => settle(undefined, error));
    child.on('close', (exitCode) => settle(exitCode ?? undefined));
  });
}

function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      for (const liveRun of liveHarnessRuns) {
        try {
          killHarnessTree(liveRun.pid);
        } catch {
          // The tree already exited.
        }
        // Best-effort cleanup while exiting; judged code may have left permission-locked entries.
        forciblyRemoveDirectorySync(liveRun.tempRoot);
      }
      process.kill(process.pid, signal);
    });
  }
}

// On Windows the harness is not detached (process groups are unavailable), so killing only the
// direct child would leave submission grandchildren running; taskkill terminates the whole tree.
function killHarnessTree(pid: number): void {
  if (process.platform === 'win32') {
    child_process.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    process.kill(-pid, 'SIGKILL');
  }
}

// The all-problem check runs harnesses concurrently and has no sandbox-delegation contract, while the sandbox
// helpers assume one harness at a time (their pkill targets every process of the sandbox user), so
// never forward the sandbox user to judged runs.
function createHarnessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.EXERCODE_SANDBOX_USER;
  return env;
}

function parseCheckArgs(args: readonly string[]): CheckOptions {
  const options: CheckOptions = {
    rootDir: '.',
    // Serial by default: judging decides TIME_LIMIT_EXCEEDED from wall-clock time, so parallel
    // runs on a small CI runner could fail timing-sensitive problems non-deterministically.
    concurrency: 1,
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
