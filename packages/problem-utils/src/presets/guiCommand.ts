import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { getErrorMessage } from '@willbooster/shared-lib';

import { z } from 'zod';

import { cleanWorkingDirectory, snapshotWorkingDirectory } from '../helpers/cleanWorkingDirectory.js';
import { copyTestCaseFileInput } from '../helpers/copyTestCaseFileInput.js';
import { findEntryPointFile } from '../helpers/findEntryPointFile.js';
import { findLanguageDefinitionByPath } from '../helpers/findLanguageDefinitionByPath.js';
import { GuiRecorder } from '../helpers/guiRecording.js';
import type { GuiRecordingFile } from '../helpers/guiRecording.js';
import { judgeByStaticAnalysis } from '../helpers/judgeByStaticAnalysis.js';
import { parseArgs } from '../helpers/parseArgs.js';
import { printTestCaseResult } from '../helpers/printTestCaseResult.js';
import { readOutputFiles } from '../helpers/readOutputFiles.js';
import { readProblemMarkdownFrontMatter } from '../helpers/readProblemMarkdownFrontMatter.js';
import { readTestCases as readFileTestCases } from '../helpers/readTestCases.js';
import { spawnWithTimeout } from '../helpers/spawnWithTimeout.js';
import { MAX_STDOUT_LENGTH } from '../helpers/stdioJudgeRules.js';
import { DecisionCode } from '../types/decisionCode.js';
import { languageIdToDefinition } from '../types/language.js';
import type { ProblemMarkdownFrontMatter } from '../types/problem.js';
import type { TestCaseResult } from '../types/testCaseResult.js';

const BUILD_TIMEOUT_SECONDS = 10;
const JUDGE_DEFAULT_TIMEOUT_SECONDS = 5;
const SCREENSHOT_WAIT_SECONDS = 0.3;
const XVFB_STARTUP_WAIT_SECONDS = 0.3;
const XVFB_SHUTDOWN_WAIT_SECONDS = 0.1;
const PROCESS_SHUTDOWN_WAIT_SECONDS = 0.2;
const STOP_DETECTION_THRESHOLD = 5;
const TIMEOUT_COMMAND_MARGIN_SECONDS = 1;
// What `TIME_COMMAND` appends to stderr: the elapsed seconds and the peak memory in KiB.
const TIME_OUTPUT_PATTERN = /(?:^|\n)(\d+\.\d+) (\d+)\s*$/;
const TIME_COMMAND = [os.platform() === 'darwin' ? 'gtime' : '/usr/bin/time', '--format', '%e %M'] as const;

const judgeParamsSchema = z.object({
  language: z.union([z.string(), z.array(z.string())]).optional(),
});

/** What every GUI test case needs; a custom `readTestCases` may add any fields of its own. */
interface BaseGuiTestCase {
  id: string;
  /** Standard input (`test_cases/<id>.in`). */
  input?: string;
  /** Directory copied into the working directory before the run (`test_cases/<id>.fin/`). */
  fileInputPath?: string;
}

/** A test case read from `test_cases/` by the default reader. */
export interface GuiTestCase extends BaseGuiTestCase {
  /** Expected standard output (`test_cases/<id>.out`), for the problem's `test` to compare. */
  output?: string;
  /** Directory of expected output files (`test_cases/<id>.fout/`), for the problem's `test` to compare. */
  fileOutputPath?: string;
}

export interface GuiScreenshotFile {
  path: string;
  data: string;
  encoding: 'base64';
}

export type { GuiRecordingFile } from '../helpers/guiRecording.js';

export interface GuiCommandRunResult {
  stdin: string;
  stdout: string;
  stderr: string;
  status: number | undefined;
  timeSeconds: number;
  memoryBytes: number;
  screenshots: GuiScreenshotFile[];
  /**
   * With `recordsAnimation`, an animated PNG (`<window name>_<window id>_recording.png`) of each
   * window that kept changing during the run; a window that only appeared and was painted has none.
   */
  recordings?: GuiRecordingFile[];
  stopReason: 'process_exit' | 'stable_screenshot' | 'timeout';
}

interface CapturedWindow {
  windowId: string;
  isSinglePixel: boolean;
  screenshot: GuiScreenshotFile;
}

interface GuiJudgeContext {
  timeLimitSeconds: number;
  problemMarkdownFrontMatter: Pick<ProblemMarkdownFrontMatter, 'memoryLimitByte' | 'requiredOutputFilePaths'>;
}

type GuiJudgeCaseResult = Pick<
  TestCaseResult,
  'decisionCode' | 'feedbackMarkdown' | 'stderr' | 'stdout' | 'outputFiles'
>;

export interface GuiCommandJudgePresetOptions<TTestCase extends BaseGuiTestCase = GuiTestCase> {
  mainFilePath?: string;
  runTimeoutSeconds?: number;
  screenshotWaitSeconds?: number;
  stopDetectionThreshold?: number;
  /**
   * Records the windows into `runResult.recordings` for a grader to watch. The time limit then ends
   * the recording instead of failing the run: a run stopped by it reaches `test` with
   * `stopReason: 'timeout'` rather than being reported as `TIME_LIMIT_EXCEEDED`.
   */
  recordsAnimation?: boolean;
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
    screenshotWaitSeconds: number;
    stopDetectionThreshold: number;
    recordsAnimation: boolean;
  }) => Promise<GuiCommandRunResult> | GuiCommandRunResult;
  test: (context: {
    testCase: TTestCase;
    runResult: Required<GuiCommandRunResult>;
    outputFiles: NonNullable<TestCaseResult['outputFiles']>;
    /** The submission's working directory, e.g. for `compareExpectedOutputFiles(cwd, testCase.fileOutputPath)`. */
    cwd: string;
    context: GuiJudgeContext;
  }) => Promise<Partial<GuiJudgeCaseResult>> | Partial<GuiJudgeCaseResult>;
}

/**
 * A preset function for judging GUI programs by collecting screenshots while the program runs.
 *
 * Keep problem-specific logic in `prepare`, `command`, and `test`. Set `recordsAnimation` to also
 * hand `test` an animated PNG of each window that kept changing, e.g. to attach to `outputFiles`.
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
export async function guiCommandJudgePreset<TTestCase extends BaseGuiTestCase = GuiTestCase>(
  problemDir: string,
  options: GuiCommandJudgePresetOptions<TTestCase>
): Promise<void> {
  const args = parseArgs(process.argv);
  if (!args.cwd) throw new Error('cwd argument required');
  const params = judgeParamsSchema.parse(args.params);
  const submissionDir = args.cwd;

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
        stderr: getErrorMessage(error),
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

  let customPrepareResult: Partial<GuiJudgeCaseResult> | undefined;
  if (options.prepare) {
    try {
      customPrepareResult = await options.prepare({
        cwd: submissionDir,
        env,
        mainFilePath: resolvedMainFilePath,
        problemMarkdownFrontMatter,
      });
    } catch (error) {
      // Like the `prebuild` step above: report the failed build rather than letting the throw end the
      // run resultless.
      printTestCaseResult({
        testCaseId: prebuildTestCaseId,
        decisionCode: DecisionCode.BUILD_ERROR,
        stderr: getErrorMessage(error),
      });
      return;
    }
  }
  const prepareResult =
    customPrepareResult ??
    (await runDefaultPrepare({
      cwd: args.cwd,
      env,
      mainFilePath: resolvedMainFilePath,
      languageDefinition,
    }));
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

      let runResult: Required<GuiCommandRunResult>;
      try {
        const runContext = {
          command,
          stdin,
          cwd: submissionDir,
          env: runEnv,
          timeLimitSeconds,
          screenshotWaitSeconds: options.screenshotWaitSeconds ?? SCREENSHOT_WAIT_SECONDS,
          stopDetectionThreshold: options.stopDetectionThreshold ?? STOP_DETECTION_THRESHOLD,
          recordsAnimation: options.recordsAnimation ?? false,
        };
        const result = options.runCommand
          ? await options.runCommand({ testCase, ...runContext })
          : await spawnGuiProgram(runContext);
        runResult = { ...result, recordings: result.recordings ?? [] };
      } catch (error) {
        printTestCaseResult({
          testCaseId: testCase.id,
          decisionCode: DecisionCode.RUNTIME_ERROR,
          stdin,
          stderr: getErrorMessage(error),
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
      const baseJudgeResult = evaluateGuiRunResult({
        runResult,
        outputFiles,
        context: judgeContext,
        acceptsTimeout: options.recordsAnimation ?? false,
      });
      let judgeResult = baseJudgeResult;
      if (baseJudgeResult.decisionCode === DecisionCode.ACCEPTED) {
        try {
          const extendedJudgeResult = await options.test({
            testCase,
            runResult,
            outputFiles,
            cwd: args.cwd,
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
            stderr: getErrorMessage(error),
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
      stderr: getErrorMessage(error),
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

async function runDefaultPrepare(context: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  mainFilePath: string;
  languageDefinition: NonNullable<ReturnType<typeof findLanguageDefinitionByPath>>;
}): Promise<Partial<GuiJudgeCaseResult> | undefined> {
  const buildCommand = context.languageDefinition.buildCommand?.(context.mainFilePath);
  if (!buildCommand) return undefined;

  const buildResult = await spawnWithTimeout(
    buildCommand[0],
    buildCommand.slice(1),
    { cwd: context.cwd, env: context.env },
    BUILD_TIMEOUT_SECONDS
  );
  const buildOutput = (buildResult.stderr || buildResult.stdout).slice(0, MAX_STDOUT_LENGTH) || undefined;

  if (buildResult.timeSeconds > BUILD_TIMEOUT_SECONDS) {
    return {
      decisionCode: DecisionCode.BUILD_TIME_LIMIT_EXCEEDED,
      stderr: buildOutput,
    };
  }

  if (buildResult.status !== 0) {
    return {
      decisionCode: DecisionCode.BUILD_ERROR,
      stderr: buildOutput,
    };
  }

  if (buildResult.outputLimitExceeded) {
    return {
      decisionCode: DecisionCode.BUILD_OUTPUT_SIZE_LIMIT_EXCEEDED,
      stderr: buildOutput,
    };
  }

  return undefined;
}

function evaluateGuiRunResult(context: {
  runResult: GuiCommandRunResult;
  outputFiles: NonNullable<TestCaseResult['outputFiles']>;
  context: GuiJudgeContext;
  acceptsTimeout: boolean;
}): Partial<GuiJudgeCaseResult> {
  if (context.runResult.stopReason === 'timeout' && !context.acceptsTimeout) {
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
  // The default reader yields the base shape; a narrower TTestCase must come from `options.readTestCases`.
  return (await readFileTestCases(path.join(problemDir, 'test_cases'))) as unknown as readonly TTestCase[];
}

async function spawnGuiProgram(context: {
  command: readonly [string, ...string[]];
  stdin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeLimitSeconds: number;
  screenshotWaitSeconds: number;
  stopDetectionThreshold: number;
  recordsAnimation: boolean;
}): Promise<GuiCommandRunResult> {
  // The capture loop below enforces the time limit while the program still shows its windows, so the
  // last capture of a timed-out run is not taken after `timeout` killed it; `timeout` only backs it up.
  const child = childProcess.spawn(
    'timeout',
    [(context.timeLimitSeconds + TIMEOUT_COMMAND_MARGIN_SECONDS).toFixed(3), ...TIME_COMMAND, ...context.command],
    {
      cwd: context.cwd,
      env: context.env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stdout = '';
  let stderr = '';
  let exitCode: number | undefined;
  let spawnError: Error | undefined;
  let stopReason: GuiCommandRunResult['stopReason'] = 'process_exit';
  const screenshotSignaturesHistory: string[][] = [];
  let screenshots: GuiScreenshotFile[] = [];
  const recorder = context.recordsAnimation ? new GuiRecorder() : undefined;
  const startTimeSeconds = Date.now() / 1000;
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
  // A child that exits before the input is fully written makes the write fail; without a listener
  // that EPIPE would be an unhandled stream error terminating the harness mid-run.
  child.stdin.on('error', () => {
    // The submission simply stopped reading its input; the exit handling below reports the result.
  });
  child.on('close', (code, signal) => {
    // `timeout` kills the program only after the margin, so a program that ended by itself in between
    // is told apart by the run time GNU time measured, not by when this callback happens to run.
    const measuredSeconds = Number(TIME_OUTPUT_PATTERN.exec(stderr)?.[1]);
    if (code === 124 || measuredSeconds > context.timeLimitSeconds) {
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

  // Stop the program even when a helper throws (e.g. `xwininfo` missing); the spawned process
  // would otherwise outlive this run.
  try {
    if (context.stdin) child.stdin.write(context.stdin);
    child.stdin.end();

    while (exitCode === undefined) {
      await wait(context.screenshotWaitSeconds * 1000);
      // The program outlives the time limit by the margin of `timeout`; a capture taken in that
      // margin is the last one of a timed-out run and never makes the run a stable one.
      const isPastTimeLimit = Date.now() / 1000 - startTimeSeconds > context.timeLimitSeconds;
      sampledMemoryBytes = Math.max(sampledMemoryBytes, readProcessGroupMemoryBytes(child.pid));
      const capturedWindows = takeScreenshots(context.env.DISPLAY);
      const capturedAtMs = Date.now();
      for (const { windowId, isSinglePixel, screenshot } of capturedWindows) {
        // Java creates an unmapped 1x1 window per program, of which `maim` captures the whole screen instead.
        if (!isSinglePixel) recorder?.add(windowId, screenshot, capturedAtMs);
      }
      screenshots = capturedWindows
        .map(({ screenshot }) => screenshot)
        .toSorted((a, b) => a.data.length - b.data.length);

      if (screenshots.length > 0 && !isPastTimeLimit) {
        const screenshotSignatures = screenshots.map((file) => file.data).toSorted();
        screenshotSignaturesHistory.unshift(screenshotSignatures);
        screenshotSignaturesHistory.length = Math.min(
          screenshotSignaturesHistory.length,
          context.stopDetectionThreshold
        );
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

      if (Date.now() / 1000 - startTimeSeconds > context.timeLimitSeconds) {
        stopReason = 'timeout';
        exitCode = 0;
        break;
      }
    }

    if (stopReason !== 'process_exit' && child.exitCode === null) {
      child.removeAllListeners('close');
      child.removeAllListeners('error');
    }
  } finally {
    await stopProcess(child);
  }
  if (spawnError) throw spawnError;
  const {
    memoryBytes,
    stderr: normalizedStderr,
    timeSeconds,
  } = parseTimedStderr(stderr, startTimeSeconds, sampledMemoryBytes);

  return {
    stdin: context.stdin,
    stdout: stdout.trimEnd(),
    stderr: normalizedStderr,
    status: exitCode,
    timeSeconds,
    memoryBytes,
    screenshots,
    recordings: recorder?.build(context.screenshotWaitSeconds * 1000) ?? [],
    stopReason,
  };
}

function takeScreenshots(display: string | undefined): CapturedWindow[] {
  // Node omits environment entries whose value is undefined, so a missing display is simply not set.
  const env = { ...process.env, DISPLAY: display ?? process.env.DISPLAY };
  const xwininfo = childProcess.spawnSync('xwininfo', ['-root', '-tree'], { encoding: 'utf8', env });
  if (xwininfo.error) throw xwininfo.error;
  if (xwininfo.status !== 0 || !xwininfo.stdout) return [];

  const capturedWindows: CapturedWindow[] = [];
  for (const { windowId, isSinglePixel } of extractTopLevelWindows(xwininfo.stdout)) {
    const screenshot = childProcess.spawnSync('maim', ['-i', windowId], { env });
    if (screenshot.error) throw screenshot.error;
    if (screenshot.status !== 0 || screenshot.stdout.length === 0) continue;

    const windowNameResult = childProcess.spawnSync('xdotool', ['getwindowname', windowId], { encoding: 'utf8', env });
    if (windowNameResult.error) throw windowNameResult.error;
    const windowName = windowNameResult.stdout.trim().replaceAll(/[\s/]/g, '_');

    capturedWindows.push({
      windowId,
      isSinglePixel,
      screenshot: {
        path: `${windowName || 'window'}_${windowId}.png`,
        data: screenshot.stdout.toString('base64'),
        encoding: 'base64',
      },
    });
  }

  return capturedWindows;
}

function extractTopLevelWindows(stdout: string): Pick<CapturedWindow, 'windowId' | 'isSinglePixel'>[] {
  const windows: Pick<CapturedWindow, 'windowId' | 'isSinglePixel'>[] = [];
  const lines = stdout.split('\n');
  for (const line of lines) {
    if (line.includes('Root window id:') || line.includes('Parent window id:') || line.includes('()')) continue;

    const match = /^\s{5}(0x[\da-f]+) /.exec(line);
    if (!match?.[1]) continue;
    windows.push({
      windowId: Number.parseInt(match[1], 16).toString(),
      // A line ends with the geometry, e.g. `400x240+0+0  +0+0`.
      isSinglePixel: / 1x1[+-]\d+[+-]\d+ {2}[+-]\d+[+-]\d+\s*$/.test(line),
    });
  }
  return windows;
}

function parseTimedStderr(
  stderr: string,
  startTimeSeconds: number,
  sampledMemoryBytes: number
): Pick<GuiCommandRunResult, 'stderr' | 'timeSeconds' | 'memoryBytes'> {
  const match = TIME_OUTPUT_PATTERN.exec(stderr);
  const normalizedStderr = match ? stderr.slice(0, match.index).trimEnd() : stderr.trimEnd();
  const parsedMemoryBytes = Number(match?.[2]) * 1024 || 0;
  return {
    stderr: normalizedStderr,
    timeSeconds: Number(match?.[1]) || Date.now() / 1000 - startTimeSeconds,
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
    const xvfb = childProcess.spawn('Xvfb', [display, '-screen', '0', '1280x1024x24', '-ac'], { stdio: 'ignore' });
    xvfb.on('error', (error) => {
      spawnError = error;
    });

    await wait(XVFB_STARTUP_WAIT_SECONDS * 1000);
    if (spawnError) throw spawnError;
    if (xvfb.exitCode !== null) continue;

    return {
      display,
      dispose: async () => {
        if (!xvfb.killed) {
          xvfb.kill('SIGTERM');
          await wait(XVFB_SHUTDOWN_WAIT_SECONDS * 1000);
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
  await wait(PROCESS_SHUTDOWN_WAIT_SECONDS * 1000);
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
