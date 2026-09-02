import path from 'node:path';

import { z } from 'zod';

import { cleanWorkingDirectory, snapshotWorkingDirectory } from '../helpers/cleanWorkingDirectory.js';
import { judgeAgainstExpectations } from '../helpers/compareExpectedOutputFiles.js';
import { copyTestCaseFileInput } from '../helpers/copyTestCaseFileInput.js';
import { findEntryPointFile } from '../helpers/findEntryPointFile.js';
import { findLanguageDefinitionByPath } from '../helpers/findLanguageDefinitionByPath.js';
import { judgeByStaticAnalysis } from '../helpers/judgeByStaticAnalysis.js';
import { parseArgs } from '../helpers/parseArgs.js';
import { printTestCaseResult } from '../helpers/printTestCaseResult.js';
import { readOutputFiles } from '../helpers/readOutputFiles.js';
import { runCustomRunner } from '../helpers/runCustomRunner.js';
import { passesIsolationCheckInDebugMode } from '../helpers/runIsolationCheckInDebugMode.js';
import {
  getSandboxUserEnvOverrides,
  makeAccessibleToSandboxUser,
  wrapCommandWithSandboxUser,
} from '../helpers/sandboxUser.js';
import { readProblemMarkdownFrontMatter } from '../helpers/readProblemMarkdownFrontMatter.js';
import { readTestCases as readFileTestCases } from '../helpers/readTestCases.js';
import {
  printDebugCwdBanner,
  printDebugExpectationFailureBanner,
  resolveCwds,
  type ResolvedCwd,
} from '../helpers/resolveCwds.js';
import { spawnSyncWithTimeout } from '../helpers/spawnSyncWithTimeout.js';
import { DecisionCode } from '../types/decisionCode.js';
import type { ProblemMarkdownFrontMatter } from '../types/problem.js';
import type { TestCaseResult } from '../types/testCaseResult.js';

const BUILD_TIMEOUT_SECONDS = 10;
const JUDGE_DEFAULT_TIMEOUT_SECONDS = 2;
const MAX_STDOUT_LENGTH = 50_000;

const judgeParamsSchema = z.object({
  language: z.union([z.string(), z.array(z.string())]).optional(),
});

type JudgeParams = z.infer<typeof judgeParamsSchema>;

/** What every command test case needs; a custom `readTestCases` may add any fields of its own. */
interface BaseCommandTestCase {
  id: string;
  /** Standard input (`test_cases/<id>.in`). */
  input?: string;
  /** Directory copied into the working directory before the run (`test_cases/<id>.fin/`). */
  fileInputPath?: string;
}

/** A test case read from `test_cases/` by the default reader. */
export interface CommandTestCase extends BaseCommandTestCase {
  /** Expected standard output (`test_cases/<id>.out`). */
  output?: string;
  /** Directory of expected output files compared after the run (`test_cases/<id>.fout/`). */
  fileOutputPath?: string;
}

type CommandJudgeCaseResult = Pick<TestCaseResult, 'decisionCode' | 'feedbackMarkdown' | 'stderr'>;

export interface CommandRunResult {
  stdin: string;
  stdout: string;
  stderr: string;
  status: number | undefined;
  timeSeconds: number;
  memoryBytes: number;
  outputLimitExceeded?: boolean;
}

interface CommandJudgeContext {
  timeLimitSeconds: number;
  outputLimitLength: number;
  problemMarkdownFrontMatter: Pick<ProblemMarkdownFrontMatter, 'memoryLimitByte' | 'requiredOutputFilePaths'>;
}

export interface CommandJudgeLimits {
  buildTimeoutSeconds: number;
  maxOutputLength: number;
}

interface ResolvedCommandProblem<TTestCase extends BaseCommandTestCase> {
  problemMarkdownFrontMatter: ProblemMarkdownFrontMatter;
  testCases: readonly TTestCase[];
  limits: CommandJudgeLimits;
  timeLimitSeconds: number;
}

export interface CommandJudgePresetOptions<
  TTestCase extends BaseCommandTestCase = CommandTestCase,
  TRunResult extends CommandRunResult = CommandRunResult,
> {
  /**
   * Set to false when the custom runner builds the submitted source itself.
   * Defaults to true.
   */
  buildSubmission?: boolean;
  limits?: CommandJudgeLimits;
  runTimeoutSeconds?: number;
  readTestCases?: (problemDir: string) => Promise<readonly TTestCase[]>;
  /**
   * Runs as the trusted harness user with the submission's `cwd`. Fixture files it creates there
   * must be written with `createDirectoryWithoutFollowingSymlinks`/`writeFileWithoutFollowingSymlinks`
   * (both exported): a submission can plant a symlink at a fixture path, and a plain `fs.writeFile`
   * would follow it into a file only the harness can write.
   */
  resolveInput?: (context: { testCase: TTestCase; cwd: string; env: NodeJS.ProcessEnv }) => Promise<string> | string;
  runCommand?: (context: {
    testCase: TTestCase;
    /**
     * The command to run. Under `EXERCODE_SANDBOX_USER` delegation it is already wrapped so it
     * executes as the sandbox user; spawn it as given (with the supplied `env`) instead of
     * reconstructing it, or the submission runs as the trusted harness user.
     *
     * Its direct child is then a root-owned `sudo` whose descendants belong to the sandbox user, so
     * the handler cannot signal them: enforce `timeLimitSeconds` with `startSandboxTimeoutWatchdog`
     * and `killSandboxUserProcesses` (both exported) rather than `child.kill()` or an outer
     * `timeout`. The preset terminates leftover sandbox processes after the handler returns.
     */
    command: readonly [string, ...string[]];
    stdin: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeLimitSeconds: number;
  }) => Promise<TRunResult> | TRunResult;
  /**
   * Decides the verdict of a run that passed the limit checks. It replaces the default comparison
   * of `testCase.output` (space-separated tokens) and `testCase.fileOutputPath` (see
   * `compareStdoutAsSpaceSeparatedTokens` and `compareExpectedOutputFiles`, both exported), so
   * call those yourself when the test case ships `.out` / `.fout` expectations to keep.
   * `outputFiles` is the array printed with the result and may be edited in place.
   */
  test?: (context: {
    testCase: TTestCase;
    runResult: TRunResult;
    outputFiles: NonNullable<TestCaseResult['outputFiles']>;
    /** The submission's working directory, e.g. for `compareExpectedOutputFiles(cwd, testCase.fileOutputPath)`. */
    cwd: string;
    context: CommandJudgeContext;
  }) => Promise<Partial<CommandJudgeCaseResult>> | Partial<CommandJudgeCaseResult> | undefined;
}

/**
 * A preset function for judging by executable command.
 *
 * Without options, test cases come from `test_cases/` (`.in`, `.out`, `.fin/`, `.fout/`) and a run
 * within the limits is accepted when its stdout matches `.out` and its files match `.fout/`; a
 * case without either expectation only has to run within the limits.
 * Keep problem-specific logic in `resolveInput` and `test`.
 *
 * @example
 * Create `judge.ts` that judges `test_cases/` like the default stdio harness, with the command
 * preset's debug mode and custom limits:
 * ```ts
 * import { commandJudgePreset } from '@exercode/problem-utils/presets/command';
 *
 * await commandJudgePreset(import.meta.dirname, { runTimeoutSeconds: 10 });
 * ```
 *
 * @example
 * Create `judge.ts` with an own verdict:
 * ```ts
 * import { commandJudgePreset } from '@exercode/problem-utils/presets/command';
 * import { DecisionCode } from '@exercode/problem-utils';
 *
 * await commandJudgePreset(import.meta.dirname, {
 *   readTestCases: async () => [
 *     { id: '01', input: '1 2' },
 *   ],
 *   test: ({ runResult }) => {
 *     return runResult.stdout.trim() === '3'
 *       ? { decisionCode: DecisionCode.ACCEPTED }
 *       : { decisionCode: DecisionCode.WRONG_ANSWER };
 *   },
 * });
 * ```
 *
 * Run with the required parameters:
 * ```bash
 * bun judge.ts model_answers/python '{ "language": "python" }'
 * ```
 *
 * Run without a cwd argument to judge each `<problemDir>/model_answers/*` directory
 * for debugging. A prominent banner is printed for each run.
 * ```bash
 * bun judge.ts
 * ```
 */
export async function commandJudgePreset<
  TTestCase extends BaseCommandTestCase = CommandTestCase,
  TRunResult extends CommandRunResult = CommandRunResult,
>(problemDir: string, options: CommandJudgePresetOptions<TTestCase, TRunResult> = {}): Promise<void> {
  const args = parseArgs(process.argv);
  const params = judgeParamsSchema.parse(args.params);

  const { cwds, isDebugMode } = await resolveCwds(problemDir, args.cwd);
  const problemMarkdownFrontMatter = await readProblemMarkdownFrontMatter(problemDir);
  const testCases = await (options.readTestCases ?? readCommandTestCases)(problemDir);
  const limits = {
    buildTimeoutSeconds: options.limits?.buildTimeoutSeconds ?? BUILD_TIMEOUT_SECONDS,
    maxOutputLength: options.limits?.maxOutputLength ?? MAX_STDOUT_LENGTH,
  };
  const timeLimitSeconds =
    typeof problemMarkdownFrontMatter.timeLimitMs === 'number'
      ? problemMarkdownFrontMatter.timeLimitMs / 1000
      : (options.runTimeoutSeconds ?? JUDGE_DEFAULT_TIMEOUT_SECONDS);
  const problem: ResolvedCommandProblem<TTestCase> = {
    problemMarkdownFrontMatter,
    testCases,
    limits,
    timeLimitSeconds,
  };

  if (isDebugMode) {
    const expectedMaxDurationMs = (limits.buildTimeoutSeconds + testCases.length * timeLimitSeconds) * 1000;
    if (!(await passesIsolationCheckInDebugMode(problemDir, cwds, params, { expectedMaxDurationMs }))) {
      process.exitCode = 1;
      return;
    }
  }

  for (const resolvedCwd of cwds) {
    if (isDebugMode) printDebugCwdBanner(problemDir, resolvedCwd);
    const result = await runCommandJudgeForCwd<TTestCase, TRunResult>(resolvedCwd.cwd, params, problem, options);
    if (isDebugMode && !matchesExpectedResult(resolvedCwd, result)) {
      process.exitCode = 1;
      printDebugExpectationFailureBanner(problemDir, resolvedCwd);
    }
  }
}

async function runCommandJudgeForCwd<
  TTestCase extends BaseCommandTestCase,
  TRunResult extends CommandRunResult = CommandRunResult,
>(
  cwd: string,
  params: JudgeParams,
  problem: ResolvedCommandProblem<TTestCase>,
  options: CommandJudgePresetOptions<TTestCase, TRunResult>
): Promise<{ allAccepted: boolean }> {
  // The sandboxed submission must read its sources and write build/run outputs in its directory.
  makeAccessibleToSandboxUser(cwd);

  const { problemMarkdownFrontMatter, testCases, limits, timeLimitSeconds } = problem;
  const prebuildTestCaseId = testCases[0]?.id ?? 'prebuild';

  const staticAnalysisResult = await judgeByStaticAnalysis(cwd, problemMarkdownFrontMatter);
  if (staticAnalysisResult) {
    printTestCaseResult({ testCaseId: prebuildTestCaseId, ...staticAnalysisResult });
    return { allAccepted: false };
  }

  const originalMainFilePath = await findEntryPointFile(cwd, params.language);
  if (!originalMainFilePath) {
    printTestCaseResult({
      testCaseId: prebuildTestCaseId,
      decisionCode: DecisionCode.MISSING_REQUIRED_SUBMISSION_FILE_ERROR,
      stderr: `main file not found${params.language ? `: language: ${params.language}` : ''}`,
    });
    return { allAccepted: false };
  }

  const languageDefinition = findLanguageDefinitionByPath(originalMainFilePath);
  if (!languageDefinition) {
    printTestCaseResult({
      testCaseId: prebuildTestCaseId,
      decisionCode: DecisionCode.WRONG_ANSWER,
      stderr: 'unsupported language',
    });
    return { allAccepted: false };
  }

  // `CI` changes affects Chainlit. `FORCE_COLOR` affects Bun.
  const env = { ...process.env, CI: '', FORCE_COLOR: '0' };

  let mainFilePath = originalMainFilePath;
  if (options.buildSubmission !== false) {
    if (languageDefinition.prebuild) {
      try {
        await languageDefinition.prebuild(cwd);
        const prebuiltMainFilePath = await findEntryPointFile(cwd, params.language);
        if (prebuiltMainFilePath) mainFilePath = prebuiltMainFilePath;
      } catch (error) {
        printTestCaseResult({
          testCaseId: prebuildTestCaseId,
          decisionCode: DecisionCode.BUILD_ERROR,
          stderr: error instanceof Error ? error.message : String(error),
        });
        return { allAccepted: false };
      }
    }

    const buildCommand = languageDefinition.buildCommand?.(mainFilePath);
    if (buildCommand) {
      const buildResult = runBuild(buildCommand, {
        cwd,
        env,
        testCaseId: prebuildTestCaseId,
        limits,
      });
      if (buildResult) {
        printTestCaseResult(buildResult);
        return { allAccepted: false };
      }
    }
  }

  const cwdSnapshot = await snapshotWorkingDirectory(cwd);

  if (testCases.length === 0) {
    printTestCaseResult({ testCaseId: 'default', decisionCode: DecisionCode.ACCEPTED });
    return { allAccepted: true };
  }

  const sharedFileInputPath = (testCases as { shared?: { fileInputPath?: string } }).shared?.fileInputPath;

  for (const testCase of testCases) {
    if (sharedFileInputPath) await copyTestCaseFileInput(sharedFileInputPath, cwd);
    if (testCase.fileInputPath) await copyTestCaseFileInput(testCase.fileInputPath, cwd);

    const command = languageDefinition.command(mainFilePath);
    let stdin = testCase.input ?? '';
    let runResult: TRunResult;
    try {
      if (options.resolveInput) {
        stdin = await options.resolveInput({ testCase, cwd, env });
      }

      runResult = options.runCommand
        ? await runCustomRunner(
            () =>
              // Hand custom runners a command that is already sandbox-wrapped, and the matching
              // environment: they spawn it themselves, so an unwrapped command would run the
              // submission as the trusted harness user and defeat the delegation boundary.
              options.runCommand?.({
                testCase,
                command: wrapCommandWithSandboxUser(command),
                stdin,
                cwd,
                env: { ...env, ...getSandboxUserEnvOverrides(env) },
                timeLimitSeconds,
              }) as Promise<TRunResult>
          )
        : (runCommand(command, {
            stdin,
            cwd,
            env,
            timeLimitSeconds,
          }) as TRunResult);
    } catch (error) {
      printTestCaseResult({
        testCaseId: testCase.id,
        decisionCode: DecisionCode.RUNTIME_ERROR,
        stdin,
        stderr: errorToMessage(error),
      });
      await cleanWorkingDirectory(cwd, cwdSnapshot);
      return { allAccepted: false };
    }

    const outputFiles = await readOutputFiles(cwd, problemMarkdownFrontMatter.requiredOutputFilePaths ?? []);
    const judgeContext: CommandJudgeContext = {
      timeLimitSeconds,
      outputLimitLength: limits.maxOutputLength,
      problemMarkdownFrontMatter: {
        memoryLimitByte: problemMarkdownFrontMatter.memoryLimitByte,
        requiredOutputFilePaths: problemMarkdownFrontMatter.requiredOutputFilePaths,
      },
    };
    const baseJudgeResult = evaluateByLimits({ runResult, outputFiles, context: judgeContext });
    let judgeResult = baseJudgeResult;
    if (baseJudgeResult.decisionCode === DecisionCode.ACCEPTED) {
      try {
        const extendedJudgeResult = options.test
          ? await options.test({ testCase, runResult, outputFiles, cwd, context: judgeContext })
          : await compareWithExpectedOutputs({ testCase, runResult, outputFiles, cwd });
        if (extendedJudgeResult) {
          judgeResult = {
            decisionCode: extendedJudgeResult.decisionCode ?? baseJudgeResult.decisionCode,
            feedbackMarkdown: extendedJudgeResult.feedbackMarkdown,
            stderr: extendedJudgeResult.stderr,
          };
        }
      } catch (error) {
        judgeResult = {
          decisionCode: DecisionCode.RUNTIME_ERROR,
          stderr: errorToMessage(error),
        };
      }
    }

    printTestCaseResult({
      testCaseId: testCase.id,
      ...judgeResult,
      exitStatus: runResult.status,
      stdin: runResult.stdin,
      stdout: runResult.stdout.slice(0, limits.maxOutputLength) || undefined,
      stderr: (judgeResult.stderr ?? runResult.stderr).slice(0, limits.maxOutputLength) || undefined,
      timeSeconds: runResult.timeSeconds,
      memoryBytes: runResult.memoryBytes,
      outputFiles: outputFiles.length > 0 ? outputFiles : undefined,
    });

    await cleanWorkingDirectory(cwd, cwdSnapshot);
    if (judgeResult.decisionCode !== DecisionCode.ACCEPTED) return { allAccepted: false };
  }

  return { allAccepted: true };
}

function matchesExpectedResult(resolvedCwd: ResolvedCwd, result: { allAccepted: boolean }): boolean {
  return result.allAccepted === (resolvedCwd.expectedResult === 'accepted');
}

function runBuild(
  buildCommand: readonly [string, ...string[]],
  context: { cwd: string; env: NodeJS.ProcessEnv; testCaseId: string; limits: CommandJudgeLimits }
): (Omit<TestCaseResult, 'testCaseId'> & { testCaseId: string }) | undefined {
  const spawnResult = spawnSyncWithTimeout(
    buildCommand[0],
    buildCommand.slice(1),
    { cwd: context.cwd, encoding: 'utf8', env: context.env },
    context.limits.buildTimeoutSeconds
  );
  const exitStatus = spawnResult.status ?? undefined;

  if (spawnResult.status !== 0) {
    return {
      testCaseId: context.testCaseId,
      decisionCode: DecisionCode.BUILD_ERROR,
      exitStatus,
      stdout: spawnResult.stdout.slice(0, context.limits.maxOutputLength),
      stderr: spawnResult.stderr.slice(0, context.limits.maxOutputLength),
      timeSeconds: spawnResult.timeSeconds,
      memoryBytes: spawnResult.memoryBytes,
    };
  }

  if (spawnResult.timeSeconds > context.limits.buildTimeoutSeconds) {
    return {
      testCaseId: context.testCaseId,
      decisionCode: DecisionCode.BUILD_TIME_LIMIT_EXCEEDED,
      exitStatus,
      stdout: spawnResult.stdout.slice(0, context.limits.maxOutputLength),
      stderr: spawnResult.stderr.slice(0, context.limits.maxOutputLength),
      timeSeconds: spawnResult.timeSeconds,
      memoryBytes: spawnResult.memoryBytes,
    };
  }

  if (
    spawnResult.stdout.length > context.limits.maxOutputLength ||
    spawnResult.stderr.length > context.limits.maxOutputLength
  ) {
    return {
      testCaseId: context.testCaseId,
      decisionCode: DecisionCode.BUILD_OUTPUT_SIZE_LIMIT_EXCEEDED,
      exitStatus,
      stdout: spawnResult.stdout.slice(0, context.limits.maxOutputLength),
      stderr: spawnResult.stderr.slice(0, context.limits.maxOutputLength),
      timeSeconds: spawnResult.timeSeconds,
      memoryBytes: spawnResult.memoryBytes,
    };
  }

  return;
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readCommandTestCases<TTestCase extends BaseCommandTestCase = CommandTestCase>(
  problemDir: string
): Promise<readonly TTestCase[]> {
  // The default reader yields the base shape; a narrower TTestCase must come from `options.readTestCases`.
  return (await readFileTestCases(path.join(problemDir, 'test_cases'))) as unknown as readonly TTestCase[];
}

/** The default verdict: `.out` decides stdout and `.fout/` decides output files; either may be absent. */
/** The default verdict for the default reader's cases; a custom case type carries no `.out`/`.fout/` expectation. */
async function compareWithExpectedOutputs(context: {
  testCase: BaseCommandTestCase & Partial<CommandTestCase>;
  runResult: CommandRunResult;
  outputFiles: NonNullable<TestCaseResult['outputFiles']>;
  cwd: string;
}): Promise<Partial<CommandJudgeCaseResult>> {
  const { testCase, runResult, outputFiles, cwd } = context;
  const judgement = await judgeAgainstExpectations({
    stdout: runResult.stdout,
    expectedStdout: typeof testCase.output === 'string' ? testCase.output : undefined,
    fileOutputPath: typeof testCase.fileOutputPath === 'string' ? testCase.fileOutputPath : undefined,
    cwd,
    outputFiles,
  });
  outputFiles.splice(0, outputFiles.length, ...judgement.outputFiles);
  return judgement.matches ? {} : { decisionCode: DecisionCode.WRONG_ANSWER };
}

function runCommand(
  command: readonly [string, ...string[]],
  context: {
    stdin: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeLimitSeconds: number;
  }
): CommandRunResult {
  const spawnResult = spawnSyncWithTimeout(
    command[0],
    command.slice(1),
    { cwd: context.cwd, encoding: 'utf8', input: context.stdin, env: context.env },
    context.timeLimitSeconds
  );

  return {
    stdin: context.stdin,
    stdout: spawnResult.stdout,
    stderr: spawnResult.stderr,
    status: spawnResult.status ?? undefined,
    timeSeconds: spawnResult.timeSeconds,
    memoryBytes: spawnResult.memoryBytes,
  };
}

function evaluateByLimits(context: {
  runResult: CommandRunResult;
  outputFiles: NonNullable<TestCaseResult['outputFiles']>;
  context: CommandJudgeContext;
}): CommandJudgeCaseResult {
  if (context.runResult.status !== 0) {
    return { decisionCode: DecisionCode.RUNTIME_ERROR, stderr: context.runResult.stderr };
  }

  if (context.runResult.timeSeconds > context.context.timeLimitSeconds) {
    return { decisionCode: DecisionCode.TIME_LIMIT_EXCEEDED, stderr: context.runResult.stderr };
  }

  if (
    context.runResult.memoryBytes >
    (context.context.problemMarkdownFrontMatter.memoryLimitByte ?? Number.POSITIVE_INFINITY)
  ) {
    return { decisionCode: DecisionCode.MEMORY_LIMIT_EXCEEDED, stderr: context.runResult.stderr };
  }

  if (
    context.runResult.outputLimitExceeded ||
    context.runResult.stdout.length > context.context.outputLimitLength ||
    context.runResult.stderr.length > context.context.outputLimitLength
  ) {
    return { decisionCode: DecisionCode.OUTPUT_SIZE_LIMIT_EXCEEDED, stderr: context.runResult.stderr };
  }

  const requiredOutputFileCount = context.context.problemMarkdownFrontMatter.requiredOutputFilePaths?.length ?? 0;
  if (context.outputFiles.length < requiredOutputFileCount) {
    return { decisionCode: DecisionCode.MISSING_REQUIRED_OUTPUT_FILE_ERROR };
  }

  return { decisionCode: DecisionCode.ACCEPTED };
}
