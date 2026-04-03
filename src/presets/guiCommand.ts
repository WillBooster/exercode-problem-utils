import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
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
import { readProblemMarkdownFrontMatter } from '../helpers/readProblemMarkdownFrontMatter.js';
import { readTestCases as readFileTestCases } from '../helpers/readTestCases.js';
import { spawnSyncWithTimeout } from '../helpers/spawnSyncWithTimeout.js';
import { DecisionCode } from '../types/decisionCode.js';
import type { ProblemMarkdownFrontMatter } from '../types/problem.js';
import type { TestCaseResult } from '../types/testCaseResult.js';

const BUILD_TIMEOUT_SECONDS = 10;
const JUDGE_DEFAULT_TIMEOUT_SECONDS = 5;
const SCREENSHOT_WAIT_MILLISECONDS = 300;
const STOP_DETECTION_THRESHOLD = 5;

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

  const mainFilePath = await resolveMainFilePath({
    cwd: args.cwd,
    language: params.language,
    configuredMainFilePath: options.mainFilePath,
  });
  if (!mainFilePath) {
    printTestCaseResult({
      testCaseId: prebuildTestCaseId,
      decisionCode: DecisionCode.MISSING_REQUIRED_SUBMISSION_FILE_ERROR,
      stderr: options.mainFilePath
        ? `required main file not found: ${options.mainFilePath}`
        : `main file not found${params.language ? `: language: ${params.language}` : ''}`,
    });
    return;
  }

  const languageDefinition = findLanguageDefinitionByPath(mainFilePath);
  if (!languageDefinition) {
    printTestCaseResult({
      testCaseId: prebuildTestCaseId,
      decisionCode: DecisionCode.WRONG_ANSWER,
      stderr: 'unsupported language',
    });
    return;
  }

  const env = { ...process.env, CI: '', FORCE_COLOR: '0' };

  let resolvedMainFilePath = mainFilePath;
  if (languageDefinition.prebuild) {
    try {
      await languageDefinition.prebuild(args.cwd);
      const prebuiltMainFilePath = await resolveMainFilePath({
        cwd: args.cwd,
        language: params.language,
        configuredMainFilePath: options.mainFilePath,
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
  const displayServer = await ensureDisplayServer();
  try {
    const sharedFileInputPath = (configuredTestCases as { shared?: { fileInputPath?: string } }).shared?.fileInputPath;
    for (const testCase of testCases) {
      if (sharedFileInputPath) await copyTestCaseFileInput(sharedFileInputPath, args.cwd);
      if (testCase.fileInputPath) await copyTestCaseFileInput(testCase.fileInputPath, args.cwd);

      const timeLimitSeconds =
        typeof problemMarkdownFrontMatter.timeLimitMs === 'number'
          ? problemMarkdownFrontMatter.timeLimitMs / 1000
          : (options.runTimeoutSeconds ?? JUDGE_DEFAULT_TIMEOUT_SECONDS);

      const runEnv = { ...env, DISPLAY: displayServer.display };
      const stdin = (await options.resolveInput?.({ testCase, cwd: args.cwd, env: runEnv })) ?? testCase.input ?? '';
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

      const judgeContext: GuiJudgeContext = {
        timeLimitSeconds,
        problemMarkdownFrontMatter: {
          memoryLimitByte: problemMarkdownFrontMatter.memoryLimitByte,
          requiredOutputFilePaths: problemMarkdownFrontMatter.requiredOutputFilePaths,
        },
      };
      const baseJudgeResult = evaluateGuiRunResult({ runResult, context: judgeContext });
      let judgeResult = baseJudgeResult;
      if (baseJudgeResult.decisionCode === DecisionCode.ACCEPTED) {
        try {
          const extendedJudgeResult = await options.test({
            testCase,
            runResult,
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
        feedbackMarkdown: judgeResult.feedbackMarkdown,
        outputFiles: judgeResult.outputFiles,
      });

      await cleanWorkingDirectory(args.cwd, cwdSnapshot);
      if (decisionCode !== DecisionCode.ACCEPTED) break;
    }
  } finally {
    await displayServer.dispose();
  }
}

async function resolveMainFilePath(context: {
  cwd: string;
  language?: string | string[];
  configuredMainFilePath?: string;
}): Promise<string | undefined> {
  if (context.configuredMainFilePath) {
    const resolvedPath = path.join(context.cwd, context.configuredMainFilePath);
    return (await pathExists(resolvedPath)) ? context.configuredMainFilePath : undefined;
  }

  return await findEntryPointFile(context.cwd, context.language);
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
  const child = childProcess.spawn(context.command[0], context.command.slice(1), {
    cwd: context.cwd,
    env: context.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stdout = '';
  let stderr = '';
  let exitCode: number | undefined;
  let spawnError: Error | undefined;
  let stopReason: GuiCommandRunResult['stopReason'] = 'process_exit';
  const screenshotsHistory: GuiScreenshotFile[][] = [];
  let screenshots: GuiScreenshotFile[] = [];
  const startTimeMs = Date.now();

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
  child.on('close', (code) => {
    exitCode = code ?? undefined;
  });

  if (context.stdin) child.stdin.write(context.stdin);
  child.stdin.end();

  while (exitCode === undefined) {
    await wait(context.screenshotWaitMilliseconds);
    const currentScreenshots = takeScreenshots(context.env.DISPLAY);
    screenshots = currentScreenshots.toSorted((a, b) => a.data.length - b.data.length);

    if (screenshots.length > 0) {
      screenshotsHistory.unshift(screenshots);
      screenshotsHistory.length = Math.min(screenshotsHistory.length, context.stopDetectionThreshold);
      if (
        screenshotsHistory.length === context.stopDetectionThreshold &&
        screenshotsHistory.every(
          (files) =>
            files.length === screenshots.length &&
            files.every((file, index) => file.data.length === screenshots[index]?.data.length)
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

  await stopProcess(child);
  if (spawnError) throw spawnError;

  return {
    stdin: context.stdin,
    stdout: stdout.trimEnd(),
    stderr: stderr.trimEnd(),
    status: child.exitCode ?? exitCode,
    timeSeconds: (Date.now() - startTimeMs) / 1000,
    screenshots,
    stopReason,
  };
}

function takeScreenshots(display: string | undefined): GuiScreenshotFile[] {
  const env = display ? { ...process.env, DISPLAY: display } : process.env;
  const xwininfo = childProcess.spawnSync('xwininfo', ['-root', '-tree'], { encoding: 'utf8', env });
  if (xwininfo.status !== 0 || !xwininfo.stdout) return [];

  const screenshots: GuiScreenshotFile[] = [];
  for (const windowId of extractTopLevelWindowIds(xwininfo.stdout)) {
    const screenshot = childProcess.spawnSync('maim', ['-i', windowId], { env });
    if (screenshot.status !== 0 || screenshot.stdout.length === 0) continue;

    const windowName = childProcess
      .spawnSync('xdotool', ['getwindowname', windowId], { encoding: 'utf8', env })
      .stdout.trim()
      .replaceAll(/[\s/]/g, '_');

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
  for (const [index, line] of lines.entries()) {
    if (line.includes('Root window id:') || line.includes('Parent window id:') || line.includes('()')) continue;

    const nextLine = lines[index + 1] ?? '';
    if (!(nextLine.includes('children:') || nextLine.includes('child:'))) continue;

    const match = /^\s{5}(0x[\da-f]+) /.exec(line);
    if (!match?.[1]) continue;
    windowIds.push(Number.parseInt(match[1], 16).toString());
  }
  return windowIds;
}

async function ensureDisplayServer(): Promise<{ display: string; dispose: () => Promise<void> }> {
  if (process.env.DISPLAY) {
    return { display: process.env.DISPLAY, dispose: () => Promise.resolve() };
  }

  if (process.platform !== 'linux') {
    throw new Error('GUI screenshot capture is supported only on Linux.');
  }

  for (let displayNumber = 90; displayNumber < 100; displayNumber++) {
    const display = `:${displayNumber}`;
    const xvfb = childProcess.spawn('Xvfb', [display, '-screen', '0', '1280x1024x24', '-ac'], {
      stdio: 'ignore',
    });

    await wait(300);
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
  child.kill('SIGTERM');
  await wait(200);
  if (child.exitCode === null) child.kill('SIGKILL');
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
