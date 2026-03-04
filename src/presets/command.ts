import path from 'node:path';

import { z } from 'zod';

import { cleanWorkingDirectory, snapshotWorkingDirectory } from '../helpers/cleanWorkingDirectory.js';
import { copyTestCaseFileInput } from '../helpers/copyTestCaseFileInput.js';
import { findEntryPointFile } from '../helpers/findEntryPointFile.js';
import { findLanguageDefinitionByPath } from '../helpers/findLanguageDefinitionByPath.js';
import { judgeByStaticAnalysis } from '../helpers/judgeByStaticAnalysis.js';
import { parseArgs } from '../helpers/parseArgs.js';
import { printTestCaseResult } from '../helpers/printTestCaseResult.js';
import { readOutputFiles } from '../helpers/readOutputFiles.js';
import { readProblemMarkdownFrontMatter } from '../helpers/readProblemMarkdownFrontMatter.js';
import { readTestCases as readFileTestCases } from '../helpers/readTestCases.js';
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

interface BaseCommandTestCase {
  id: string;
  input?: string;
  fileInputPath?: string;
}

type CommandJudgeCaseResult = Pick<TestCaseResult, 'decisionCode' | 'feedbackMarkdown' | 'stderr'>;

export interface CommandRunResult {
  stdin: string;
  stdout: string;
  stderr: string;
  status: number | undefined;
  timeSeconds: number;
  memoryBytes: number;
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

export interface CommandJudgePresetOptions<TTestCase extends BaseCommandTestCase = BaseCommandTestCase> {
  limits?: CommandJudgeLimits;
  runTimeoutSeconds?: number;
  readTestCases?: (problemDir: string) => Promise<readonly TTestCase[]>;
  resolveInput?: (context: { testCase: TTestCase; cwd: string; env: NodeJS.ProcessEnv }) => Promise<string> | string;
  runCommand?: (context: {
    testCase: TTestCase;
    command: readonly [string, ...string[]];
    stdin: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeLimitSeconds: number;
  }) => Promise<CommandRunResult> | CommandRunResult;
  test?: (context: {
    testCase: TTestCase;
    runResult: CommandRunResult;
    outputFiles: NonNullable<TestCaseResult['outputFiles']>;
    context: CommandJudgeContext;
  }) => Promise<Partial<CommandJudgeCaseResult>> | Partial<CommandJudgeCaseResult> | undefined;
}

/**
 * A preset function for judging by executable command.
 *
 * Keep problem-specific logic in `resolveInput` and `test`.
 *
 * @example
 * Create `judge.ts`:
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
 */
export async function commandJudgePreset<TTestCase extends BaseCommandTestCase = BaseCommandTestCase>(
  problemDir: string,
  options: CommandJudgePresetOptions<TTestCase>
): Promise<void> {
  const args = parseArgs(process.argv);
  const params = judgeParamsSchema.parse(args.params);

  const problemMarkdownFrontMatter = await readProblemMarkdownFrontMatter(problemDir);
  const testCases = await (options.readTestCases ?? readCommandTestCases)(problemDir);
  const prebuildTestCaseId = testCases[0]?.id ?? 'prebuild';
  const limits = {
    buildTimeoutSeconds: options.limits?.buildTimeoutSeconds ?? BUILD_TIMEOUT_SECONDS,
    maxOutputLength: options.limits?.maxOutputLength ?? MAX_STDOUT_LENGTH,
  };
  const runTimeoutSeconds = options.runTimeoutSeconds ?? JUDGE_DEFAULT_TIMEOUT_SECONDS;

  const staticAnalysisResult = await judgeByStaticAnalysis(args.cwd, problemMarkdownFrontMatter);
  if (staticAnalysisResult) {
    printTestCaseResult({ testCaseId: prebuildTestCaseId, ...staticAnalysisResult });
    return;
  }

  const originalMainFilePath = await findEntryPointFile(args.cwd, params.language);
  if (!originalMainFilePath) {
    printTestCaseResult({
      testCaseId: prebuildTestCaseId,
      decisionCode: DecisionCode.MISSING_REQUIRED_SUBMISSION_FILE_ERROR,
      stderr: `main file not found${params.language ? `: language: ${params.language}` : ''}`,
    });
    return;
  }

  const languageDefinition = findLanguageDefinitionByPath(originalMainFilePath);
  if (!languageDefinition) {
    printTestCaseResult({
      testCaseId: prebuildTestCaseId,
      decisionCode: DecisionCode.WRONG_ANSWER,
      stderr: 'unsupported language',
    });
    return;
  }

  // `CI` changes affects Chainlit. `FORCE_COLOR` affects Bun.
  const env = { ...process.env, CI: '', FORCE_COLOR: '0' };

  let mainFilePath = originalMainFilePath;
  if (languageDefinition.prebuild) {
    try {
      await languageDefinition.prebuild(args.cwd);
      const prebuiltMainFilePath = await findEntryPointFile(args.cwd, params.language);
      if (prebuiltMainFilePath) mainFilePath = prebuiltMainFilePath;
    } catch (error) {
      printTestCaseResult({
        testCaseId: prebuildTestCaseId,
        decisionCode: DecisionCode.BUILD_ERROR,
        stderr: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  const buildCommand = languageDefinition.buildCommand?.(mainFilePath);
  if (buildCommand) {
    const buildResult = runBuild(buildCommand, {
      cwd: args.cwd,
      env,
      testCaseId: prebuildTestCaseId,
      limits,
    });
    if (buildResult) {
      printTestCaseResult(buildResult);
      return;
    }
  }

  const cwdSnapshot = await snapshotWorkingDirectory(args.cwd);

  if (testCases.length === 0) {
    printTestCaseResult({ testCaseId: 'default', decisionCode: DecisionCode.ACCEPTED });
    return;
  }

  const sharedFileInputPath = (testCases as { shared?: { fileInputPath?: string } }).shared?.fileInputPath;

  for (const testCase of testCases) {
    if (sharedFileInputPath) await copyTestCaseFileInput(sharedFileInputPath, args.cwd);
    if (testCase.fileInputPath) await copyTestCaseFileInput(testCase.fileInputPath, args.cwd);

    const timeLimitSeconds =
      typeof problemMarkdownFrontMatter.timeLimitMs === 'number'
        ? problemMarkdownFrontMatter.timeLimitMs / 1000
        : runTimeoutSeconds;

    const command = languageDefinition.command(mainFilePath);
    let stdin = testCase.input ?? '';
    let runResult: CommandRunResult;
    try {
      if (options.resolveInput) {
        stdin = await options.resolveInput({ testCase, cwd: args.cwd, env });
      }

      runResult = options.runCommand
        ? await options.runCommand({
            testCase,
            command,
            stdin,
            cwd: args.cwd,
            env,
            timeLimitSeconds,
          })
        : runCommand(command, {
            stdin,
            cwd: args.cwd,
            env,
            timeLimitSeconds,
          });
    } catch (error) {
      printTestCaseResult({
        testCaseId: testCase.id,
        decisionCode: DecisionCode.RUNTIME_ERROR,
        stdin,
        stderr: errorToMessage(error),
      });
      await cleanWorkingDirectory(args.cwd, cwdSnapshot);
      return;
    }

    const outputFiles = await readOutputFiles(args.cwd, problemMarkdownFrontMatter.requiredOutputFilePaths ?? []);
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
        const extendedJudgeResult = await options.test?.({ testCase, runResult, outputFiles, context: judgeContext });
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

    await cleanWorkingDirectory(args.cwd, cwdSnapshot);
    if (judgeResult.decisionCode !== DecisionCode.ACCEPTED) return;
  }
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

function toCommandTestCase(value: {
  id: string;
  input?: string;
  fileInputPath?: string;
  fileOutputPath?: string;
  output?: string;
}): BaseCommandTestCase {
  return { id: value.id, input: value.input, fileInputPath: value.fileInputPath };
}

async function readCommandTestCases<TTestCase extends BaseCommandTestCase = BaseCommandTestCase>(
  problemDir: string
): Promise<readonly TTestCase[]> {
  const fileTestCases = await readFileTestCases(path.join(problemDir, 'test_cases'));
  const commandTestCases = fileTestCases.map((testCase) => toCommandTestCase(testCase) as TTestCase);
  if (fileTestCases.shared?.fileInputPath) {
    return Object.assign(commandTestCases, { shared: { fileInputPath: fileTestCases.shared.fileInputPath } });
  }
  return commandTestCases;
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
