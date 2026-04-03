import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

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
import { languageIdToDefinition } from '../types/language.js';
import type { ProblemMarkdownFrontMatter } from '../types/problem.js';
import type { TestCaseResult } from '../types/testCaseResult.js';

const BUILD_TIMEOUT_SECONDS = 10;
const JUDGE_DEFAULT_TIMEOUT_SECONDS = 5;
const SCREENSHOT_WAIT_MILLISECONDS = 300;
const STOP_DETECTION_THRESHOLD = 5;
const TIME_COMMAND = [os.platform() === 'darwin' ? 'gtime' : '/usr/bin/time', '--format', '%e %M'] as const;

const judgeParamsSchema = z.object({
  language: z.union([z.string(), z.array(z.string())]).optional(),
});

interface BaseGuiTestCase {
  id: string;
  input?: string;
  fileInputPath?: string;
}

export interface GuiScreenshotFile {
  path: string;
  data: string;
  encoding: 'base64';
}

export interface GuiCommandRunResult {
  stdin: string;
  stdout: string;
  stderr: string;
  status: number | undefined;
  timeSeconds: number;
  memoryBytes: number;
  screenshots: GuiScreenshotFile[];
  stopReason: 'process_exit' | 'stable_screenshot' | 'timeout';
}

interface GuiJudgeContext {
  timeLimitSeconds: number;
  problemMarkdownFrontMatter: Pick<ProblemMarkdownFrontMatter, 'memoryLimitByte' | 'requiredOutputFilePaths'>;
}

type GuiJudgeCaseResult = Pick<
  TestCaseResult,
  'decisionCode' | 'feedbackMarkdown' | 'stderr' | 'stdout' | 'outputFiles'
>;

export interface GuiCommandJudgePresetOptions<TTestCase extends BaseGuiTestCase = BaseGuiTestCase> {
  mainFilePath?: string;
  runTimeoutSeconds?: number;
  screenshotWaitMilliseconds?: number;
  stopDetectionThreshold?: number;
  readTestCases?: (problemDir: string) => Promise<readonly TTestCase[]>;
  prepare?: (context: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    mainFilePath: string;
    problemMarkdownFrontMatter: ProblemMarkdownFrontMatter;
  }) => Promise<Partial<GuiJudgeCaseResult> | undefined> | Partial<GuiJudgeCaseResult> | undefined;
  resolveInput?: (context: { testCase: TTestCase; cwd: string; env: NodeJS.ProcessEnv }) => Promise<string> | string;
  command?: (context: {
    testCase: TTestCase;
    cwd: string;
    env: NodeJS.ProcessEnv;
    mainFilePath: string;
  }) => Promise<readonly [string, ...string[]]> | readonly [string, ...string[]];
  runCommand?: (context: {
    testCase: TTestCase;
    command: readonly [string, ...string[]];
    stdin: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeLimitSeconds: number;
    screenshotWaitMilliseconds: number;
    stopDetectionThreshold: number;
  }) => Promise<GuiCommandRunResult> | GuiCommandRunResult;
  test: (context: {
    testCase: TTestCase;
    runResult: GuiCommandRunResult;
    outputFiles: NonNullable<TestCaseResult['outputFiles']>;
    context: GuiJudgeContext;
  }) => Promise<Partial<GuiJudgeCaseResult>> | Partial<GuiJudgeCaseResult>;
}

/**
 * A preset function for judging GUI programs by collecting screenshots while the program runs.
 *
 * Keep problem-specific logic in `prepare`, `command`, and `test`.
 *
 * @example
 * Create `judge.ts`:
 * ```ts
 * import { DecisionCode } from '@exercode/problem-utils';
 * import { guiCommandJudgePreset } from '@exercode/problem-utils/presets/guiCommand';
 *
 * await guiCommandJudgePreset(import.meta.dirname, {
 *   mainFilePath: 'Main.java',
 *   readTestCases: async () => [{ id: 'default' }],
 *   test: ({ runResult }) => {
 *     return runResult.screenshots.length > 0
 *       ? { decisionCode: DecisionCode.ACCEPTED }
 *       : { decisionCode: DecisionCode.WRONG_ANSWER };
 *   },
 * });
 * ```
 */
export async function guiCommandJudgePreset<TTestCase extends BaseGuiTestCase = BaseGuiTestCase>(
  problemDir: string,
  options: GuiCommandJudgePresetOptions<TTestCase>
): Promise<void> {
  const args = parseArgs(process.argv);
  const params = judgeParamsSchema.parse(args.params);

  const problemMarkdownFrontMatter = await readProblemMarkdownFrontMatter(problemDir);
  const configuredTestCases = await (options.readTestCases ?? readGuiTestCases<TTestCase>)(problemDir);
  const testCases =
    configuredTestCases.length > 0 ? configuredTestCases : ([{ id: 'default' }] as unknown as readonly TTestCase[]);
  const prebuildTestCaseId = testCases[0]?.id ?? 'prebuild';

  const staticAnalysisResult = await judgeByStaticAnalysis(args.cwd, problemMarkdownFrontMatter);
  if (staticAnalysisResult) {
    printTestCaseResult({ testCaseId: prebuildTestCaseId, ...staticAnalysisResult });
    return;
  }

  const initialMainFilePath = options.mainFilePath ?? (await findEntryPointFile(args.cwd, params.language));
  if (!initialMainFilePath) {
    printTestCaseResult({
      testCaseId: prebuildTestCaseId,
      decisionCode: DecisionCode.MISSING_REQUIRED_SUBMISSION_FILE_ERROR,
      stderr: options.mainFilePath
        ? `required main file not found: ${options.mainFilePath}`
        : `main file not found${params.language ? `: language: ${params.language}` : ''}`,
    });
    return;
  }

  const languageDefinition = findLanguageDefinitionByPath(initialMainFilePath);
  if (!languageDefinition) {
    printTestCaseResult({
      testCaseId: prebuildTestCaseId,
      decisionCode: DecisionCode.WRONG_ANSWER,
      stderr: 'unsupported language',
    });
    return;
  }

  const env = { ...process.env, CI: '', FORCE_COLOR: '0' };

  let resolvedMainFilePath = await resolveMainFilePath({
    cwd: args.cwd,
    language: params.language,
    configuredMainFilePath: options.mainFilePath,
  });
  if (languageDefinition.prebuild) {
    try {
      await languageDefinition.prebuild(args.cwd);
      const prebuiltMainFilePath = await resolveMainFilePath({
        cwd: args.cwd,
        language: params.language ?? inferLanguageIdsByPath(initialMainFilePath),
        configuredMainFilePath: options.mainFilePath,
        allowConfiguredPathFallback: true,
      });
      if (prebuiltMainFilePath) resolvedMainFilePath = prebuiltMainFilePath;
    } catch (error) {
      printTestCaseResult({
        testCaseId: prebuildTestCaseId,
        decisionCode: DecisionCode.BUILD_ERROR,
        stderr: errorToMessage(error),
      });
      return;
    }
  }
  if (!resolvedMainFilePath) {
    printTestCaseResult({
      testCaseId: prebuildTestCaseId,
      decisionCode: DecisionCode.MISSING_REQUIRED_SUBMISSION_FILE_ERROR,
      stderr: options.mainFilePath
        ? `required main file not found: ${options.mainFilePath}`
        : `main file not found${params.language ? `: language: ${params.language}` : ''}`,
    });
    return;
  }

  const prepareResult =
    (await options.prepare?.({
      cwd: args.cwd,
      env,
      mainFilePath: resolvedMainFilePath,
      problemMarkdownFrontMatter,
    })) ??
    runDefaultPrepare({
      cwd: args.cwd,
      env,
      mainFilePath: resolvedMainFilePath,
      languageDefinition,
    });
  if (prepareResult) {
    printTestCaseResult({
      testCaseId: prebuildTestCaseId,
      decisionCode: prepareResult.decisionCode ?? DecisionCode.BUILD_ERROR,
      feedbackMarkdown: prepareResult.feedbackMarkdown,
      stderr: prepareResult.stderr,
      stdout: prepareResult.stdout,
      outputFiles: prepareResult.outputFiles,
    });
    return;
  }

  const cwdSnapshot = await snapshotWorkingDirectory(args.cwd);
  let displayServer: Awaited<ReturnType<typeof ensureDisplayServer>> | undefined;
  let currentTestCaseId = prebuildTestCaseId;
  let currentStdin: string | undefined;
  try {
    displayServer = options.runCommand ? undefined : await ensureDisplayServer();
    const sharedFileInputPath = (configuredTestCases as { shared?: { fileInputPath?: string } }).shared?.fileInputPath;
    for (const testCase of testCases) {
      currentTestCaseId = testCase.id;
      if (sharedFileInputPath) await copyTestCaseFileInput(sharedFileInputPath, args.cwd);
      if (testCase.fileInputPath) await copyTestCaseFileInput(testCase.fileInputPath, args.cwd);

      const timeLimitSeconds =
        typeof problemMarkdownFrontMatter.timeLimitMs === 'number'
          ? problemMarkdownFrontMatter.timeLimitMs / 1000
          : (options.runTimeoutSeconds ?? JUDGE_DEFAULT_TIMEOUT_SECONDS);

      const runEnv = displayServer ? { ...env, DISPLAY: displayServer.display } : env;
      const stdin = (await options.resolveInput?.({ testCase, cwd: args.cwd, env: runEnv })) ?? testCase.input ?? '';
      currentStdin = stdin;
      const command =
        (await options.command?.({ testCase, cwd: args.cwd, env: runEnv, mainFilePath: resolvedMainFilePath })) ??
        languageDefinition.command(resolvedMainFilePath);

      let runResult: GuiCommandRunResult;
      try {
        runResult = options.runCommand
          ? await options.runCommand({
              testCase,
              command,
              stdin,
              cwd: args.cwd,
              env: runEnv,
              timeLimitSeconds,
              screenshotWaitMilliseconds: options.screenshotWaitMilliseconds ?? SCREENSHOT_WAIT_MILLISECONDS,
              stopDetectionThreshold: options.stopDetectionThreshold ?? STOP_DETECTION_THRESHOLD,
            })
          : await spawnGuiProgram({
              command,
              stdin,
              cwd: args.cwd,
              env: runEnv,
              timeLimitSeconds,
              screenshotWaitMilliseconds: options.screenshotWaitMilliseconds ?? SCREENSHOT_WAIT_MILLISECONDS,
              stopDetectionThreshold: options.stopDetectionThreshold ?? STOP_DETECTION_THRESHOLD,
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
      const judgeContext: GuiJudgeContext = {
        timeLimitSeconds,
        problemMarkdownFrontMatter: {
          memoryLimitByte: problemMarkdownFrontMatter.memoryLimitByte,
          requiredOutputFilePaths: problemMarkdownFrontMatter.requiredOutputFilePaths,
        },
      };
      const baseJudgeResult = evaluateGuiRunResult({ runResult, outputFiles, context: judgeContext });
      let judgeResult = baseJudgeResult;
      if (baseJudgeResult.decisionCode === DecisionCode.ACCEPTED) {
        try {
          const extendedJudgeResult = await options.test({
            testCase,
            runResult,
            outputFiles,
            context: judgeContext,
          });
          judgeResult = {
            decisionCode: extendedJudgeResult.decisionCode ?? baseJudgeResult.decisionCode,
            feedbackMarkdown: extendedJudgeResult.feedbackMarkdown,
            stderr: extendedJudgeResult.stderr,
            stdout: extendedJudgeResult.stdout,
            outputFiles: extendedJudgeResult.outputFiles,
          };
        } catch (error) {
          judgeResult = {
            decisionCode: DecisionCode.RUNTIME_ERROR,
            stderr: errorToMessage(error),
          };
        }
      }

      const decisionCode = judgeResult.decisionCode ?? DecisionCode.ACCEPTED;
      const stdout = judgeResult.stdout ?? runResult.stdout;
      const stderr = judgeResult.stderr ?? runResult.stderr;
      printTestCaseResult({
        testCaseId: testCase.id,
        decisionCode,
        exitStatus: runResult.status,
        stdin: runResult.stdin || undefined,
        stdout: stdout || undefined,
        stderr: stderr || undefined,
        timeSeconds: runResult.timeSeconds,
        memoryBytes: runResult.memoryBytes,
        feedbackMarkdown: judgeResult.feedbackMarkdown,
        outputFiles: judgeResult.outputFiles ?? (outputFiles.length > 0 ? outputFiles : undefined),
      });

      await cleanWorkingDirectory(args.cwd, cwdSnapshot);
      if (decisionCode !== DecisionCode.ACCEPTED) break;
    }
  } catch (error) {
    printTestCaseResult({
      testCaseId: currentTestCaseId,
      decisionCode: DecisionCode.RUNTIME_ERROR,
      stdin: currentStdin,
      stderr: errorToMessage(error),
    });
    await cleanWorkingDirectory(args.cwd, cwdSnapshot);
  } finally {
    await displayServer?.dispose();
  }
}

async function resolveMainFilePath(context: {
  cwd: string;
  language?: string | string[];
  configuredMainFilePath?: string;
  allowConfiguredPathFallback?: boolean;
}): Promise<string | undefined> {
  if (context.configuredMainFilePath) {
    const resolvedPath = path.join(context.cwd, context.configuredMainFilePath);
    if (await pathExists(resolvedPath)) return context.configuredMainFilePath;
    if (!context.allowConfiguredPathFallback) return undefined;
  }

  return await findEntryPointFile(context.cwd, context.language);
}

function inferLanguageIdsByPath(filePath: string): string[] | undefined {
  const languageIds = Object.entries(languageIdToDefinition)
    .filter(([, definition]) => definition.fileExtensions.some((ext) => filePath.endsWith(ext)))
    .map(([languageId]) => languageId);
  return languageIds.length > 0 ? languageIds : undefined;
}

function runDefaultPrepare(context: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  mainFilePath: string;
  languageDefinition: NonNullable<ReturnType<typeof findLanguageDefinitionByPath>>;
}): Partial<GuiJudgeCaseResult> | undefined {
  const buildCommand = context.languageDefinition.buildCommand?.(context.mainFilePath);
  if (!buildCommand) return undefined;

  const buildResult = spawnSyncWithTimeout(
    buildCommand[0],
    buildCommand.slice(1),
    { cwd: context.cwd, encoding: 'utf8', env: context.env },
    BUILD_TIMEOUT_SECONDS
  );

  if (buildResult.timeSeconds > BUILD_TIMEOUT_SECONDS) {
    return {
      decisionCode: DecisionCode.BUILD_TIME_LIMIT_EXCEEDED,
      stderr: buildResult.stderr || undefined,
    };
  }

  if (buildResult.status !== 0) {
    return {
      decisionCode: DecisionCode.BUILD_ERROR,
      stderr: buildResult.stderr || buildResult.stdout || undefined,
    };
  }

  return undefined;
}

function evaluateGuiRunResult(context: {
  runResult: GuiCommandRunResult;
  outputFiles: NonNullable<TestCaseResult['outputFiles']>;
  context: GuiJudgeContext;
}): Partial<GuiJudgeCaseResult> {
  if (context.runResult.stopReason === 'timeout') {
    return {
      decisionCode: DecisionCode.TIME_LIMIT_EXCEEDED,
      stderr: context.runResult.stderr,
    };
  }

  if (context.runResult.status !== 0) {
    return {
      decisionCode: DecisionCode.RUNTIME_ERROR,
      stderr: context.runResult.stderr,
    };
  }

  if (
    context.runResult.memoryBytes >
    (context.context.problemMarkdownFrontMatter.memoryLimitByte ?? Number.POSITIVE_INFINITY)
  ) {
    return {
      decisionCode: DecisionCode.MEMORY_LIMIT_EXCEEDED,
      stderr: context.runResult.stderr,
    };
  }

  const requiredOutputFilesCount = context.context.problemMarkdownFrontMatter.requiredOutputFilePaths?.length ?? 0;
  if (context.outputFiles.length < requiredOutputFilesCount) {
    return {
      decisionCode: DecisionCode.MISSING_REQUIRED_OUTPUT_FILE_ERROR,
    };
  }

  return { decisionCode: DecisionCode.ACCEPTED };
}

async function readGuiTestCases<TTestCase extends BaseGuiTestCase>(problemDir: string): Promise<readonly TTestCase[]> {
  return (await readFileTestCases(path.join(problemDir, 'test_cases'))) as unknown as readonly TTestCase[];
}

async function spawnGuiProgram(context: {
  command: readonly [string, ...string[]];
  stdin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeLimitSeconds: number;
  screenshotWaitMilliseconds: number;
  stopDetectionThreshold: number;
}): Promise<GuiCommandRunResult> {
  const wrappedCommand = ['timeout', context.timeLimitSeconds.toFixed(3), ...TIME_COMMAND, ...context.command] as const;
  const child = childProcess.spawn(wrappedCommand[0], wrappedCommand.slice(1), {
    cwd: context.cwd,
    env: context.env,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stdout = '';
  let stderr = '';
  let exitCode: number | undefined;
  let spawnError: Error | undefined;
  let stopReason: GuiCommandRunResult['stopReason'] = 'process_exit';
  const screenshotSignaturesHistory: string[][] = [];
  let screenshots: GuiScreenshotFile[] = [];
  const startTimeMs = Date.now();
  let sampledMemoryBytes = 0;

  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.on('error', (error) => {
    spawnError = error;
    exitCode = 1;
  });
  child.on('close', (code, signal) => {
    if (code === 124) {
      stopReason = 'timeout';
      exitCode = 0;
      return;
    }
    if (signal) {
      exitCode = 1;
      stderr = stderr
        ? `${stderr}\nprocess terminated by signal: ${signal}`
        : `process terminated by signal: ${signal}`;
      return;
    }
    exitCode = code ?? 1;
  });

  if (context.stdin) child.stdin.write(context.stdin);
  child.stdin.end();

  while (exitCode === undefined) {
    await wait(context.screenshotWaitMilliseconds);
    sampledMemoryBytes = Math.max(sampledMemoryBytes, readProcessGroupMemoryBytes(child.pid));
    const currentScreenshots = takeScreenshots(context.env.DISPLAY);
    screenshots = currentScreenshots.toSorted((a, b) => a.data.length - b.data.length);

    if (screenshots.length > 0) {
      const screenshotSignatures = screenshots.map((file) => file.data).toSorted();
      screenshotSignaturesHistory.unshift(screenshotSignatures);
      screenshotSignaturesHistory.length = Math.min(screenshotSignaturesHistory.length, context.stopDetectionThreshold);
      if (
        screenshotSignaturesHistory.length === context.stopDetectionThreshold &&
        screenshotSignaturesHistory.every(
          (files) =>
            files.length === screenshotSignatures.length &&
            files.every((file, index) => file === screenshotSignatures[index])
        )
      ) {
        stopReason = 'stable_screenshot';
        exitCode = 0;
        break;
      }
    }

    if (Date.now() - startTimeMs > context.timeLimitSeconds * 1000) {
      stopReason = 'timeout';
      exitCode = 0;
      break;
    }
  }

  if (stopReason !== 'process_exit' && child.exitCode === null) {
    child.removeAllListeners('close');
    child.removeAllListeners('error');
  }
  await stopProcess(child);
  if (spawnError) throw spawnError;
  const {
    memoryBytes,
    stderr: normalizedStderr,
    timeSeconds,
  } = parseTimedStderr(stderr, startTimeMs, sampledMemoryBytes);

  return {
    stdin: context.stdin,
    stdout: stdout.trimEnd(),
    stderr: normalizedStderr,
    status: exitCode,
    timeSeconds,
    memoryBytes,
    screenshots,
    stopReason,
  };
}

function takeScreenshots(display: string | undefined): GuiScreenshotFile[] {
  const env = display ? { ...process.env, DISPLAY: display } : process.env;
  const xwininfo = childProcess.spawnSync('xwininfo', ['-root', '-tree'], { encoding: 'utf8', env });
  if (xwininfo.error) throw xwininfo.error;
  if (xwininfo.status !== 0 || !xwininfo.stdout) return [];

  const screenshots: GuiScreenshotFile[] = [];
  for (const windowId of extractTopLevelWindowIds(xwininfo.stdout)) {
    const screenshot = childProcess.spawnSync('maim', ['-i', windowId], { env });
    if (screenshot.error) throw screenshot.error;
    if (screenshot.status !== 0 || screenshot.stdout.length === 0) continue;

    const windowNameResult = childProcess.spawnSync('xdotool', ['getwindowname', windowId], { encoding: 'utf8', env });
    if (windowNameResult.error) throw windowNameResult.error;
    const windowName = windowNameResult.stdout.trim().replaceAll(/[\s/]/g, '_');

    screenshots.push({
      path: `${windowName || 'window'}_${windowId}.png`,
      data: screenshot.stdout.toString('base64'),
      encoding: 'base64',
    });
  }

  return screenshots;
}

function extractTopLevelWindowIds(stdout: string): string[] {
  const windowIds: string[] = [];
  const lines = stdout.split('\n');
  for (const line of lines) {
    if (line.includes('Root window id:') || line.includes('Parent window id:') || line.includes('()')) continue;

    const match = /^\s{5}(0x[\da-f]+) /.exec(line);
    if (!match?.[1]) continue;
    windowIds.push(Number.parseInt(match[1], 16).toString());
  }
  return windowIds;
}

function parseTimedStderr(
  stderr: string,
  startTimeMs: number,
  sampledMemoryBytes: number
): Pick<GuiCommandRunResult, 'stderr' | 'timeSeconds' | 'memoryBytes'> {
  const match = /(?:^|\n)(\d+\.\d+) (\d+)\s*$/.exec(stderr);
  const normalizedStderr = match ? stderr.slice(0, match.index).trimEnd() : stderr.trimEnd();
  const parsedMemoryBytes = Number(match?.[2]) * 1024 || 0;
  return {
    stderr: normalizedStderr,
    timeSeconds: Number(match?.[1]) || (Date.now() - startTimeMs) / 1000,
    memoryBytes: Math.max(parsedMemoryBytes, sampledMemoryBytes),
  };
}

async function ensureDisplayServer(): Promise<{ display: string; dispose: () => Promise<void> }> {
  if (process.platform !== 'linux') {
    throw new Error('GUI screenshot capture is supported only on Linux.');
  }

  for (let displayNumber = 90; displayNumber < 100; displayNumber++) {
    const display = `:${displayNumber}`;
    let spawnError: Error | undefined;
    const xvfb = childProcess.spawn('Xvfb', [display, '-screen', '0', '1280x1024x24', '-ac'], {
      stdio: 'ignore',
    });
    xvfb.on('error', (error) => {
      spawnError = error;
    });

    await wait(300);
    if (spawnError) throw spawnError;
    if (xvfb.exitCode !== null) continue;

    return {
      display,
      dispose: async () => {
        if (!xvfb.killed) {
          xvfb.kill('SIGTERM');
          await wait(100);
          if (xvfb.exitCode === null) xvfb.kill('SIGKILL');
        }
      },
    };
  }

  throw new Error('Xvfb could not be started.');
}

async function stopProcess(child: childProcess.ChildProcess): Promise<void> {
  if (!child.pid) return;
  killProcessGroup(child.pid, 'SIGTERM');
  await wait(200);
  if (child.exitCode === null) killProcessGroup(child.pid, 'SIGKILL');
}

function readProcessGroupMemoryBytes(processGroupId: number | undefined): number {
  if (!processGroupId || process.platform !== 'linux') return 0;

  const result = childProcess.spawnSync('ps', ['-o', 'rss=', '--no-headers', '--pgroup', String(processGroupId)], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0 || !result.stdout) return 0;

  return result.stdout
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
    .reduce((sum, value) => sum + value * 1024, 0);
}

function killProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32') {
      process.kill(-processGroupId, signal);
      return;
    }
  } catch {
    // The process group may already be gone. Fall back to the direct PID below.
  }

  try {
    process.kill(processGroupId, signal);
  } catch {
    // The direct child may also already be gone.
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
