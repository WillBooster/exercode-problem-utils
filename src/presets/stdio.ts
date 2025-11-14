import path from 'node:path';

import { z } from 'zod';

import { compareStdoutAsSpaceSeparatedTokens } from '../helpers/compareStdoutAsSpaceSeparatedTokens.js';
import { findEntryPointFile } from '../helpers/findEntryPointFile.js';
import { findLanguageDefinitionByPath } from '../helpers/findLanguageDefinitionByPath.js';
import { judgeByStaticAnalysis } from '../helpers/judgeByStaticAnalysis.js';
import { parseArgs } from '../helpers/parseArgs.js';
import { printTestCaseResult } from '../helpers/printTestCaseResult.js';
import { readOutputFiles } from '../helpers/readOutputFiles.js';
import { readProblemMarkdownFrontMatter } from '../helpers/readProblemMarkdownFrontMatter.js';
import { readTestCases } from '../helpers/readTestCases.js';
import { spawnSyncWithTimeout } from '../helpers/spawnSyncWithTimeout.js';
import { DecisionCode } from '../types/decisionCode.js';

const BUILD_TIMEOUT_SECONDS = 10;
const JUDGE_DEFAULT_TIMEOUT_SECONDS = 2;
const DEBUG_DEFAULT_TIMEOUT_SECONDS = 10;

const MAX_STDOUT_LENGTH = 50_000;

const judgeParamsSchema = z.object({
  cwd: z.string(),
  language: z.union([z.string(), z.array(z.string())]).optional(),
});

const debugParamsSchema = judgeParamsSchema.extend({
  stdin: z.string().optional(),
});

/**
 * A preset judge function using stdin and stdout as test cases.
 *
 * @example
 * Create `judge.ts`:
 * ```ts
 * import { stdioJudgePreset } from 'judge-utils/presets/stdio';
 *
 * await stdioJudgePreset(import.meta.dirname);
 * ```
 *
 * Run with the required parameters:
 * ```bash
 * bun judge.ts '{ "cwd": "model_answers/java" }'
 * ```
 */
export async function stdioJudgePreset(problemDir: string): Promise<void> {
  const args = parseArgs(process.argv);
  const params = judgeParamsSchema.parse(args.params);

  const problemMarkdownFrontMatter = await readProblemMarkdownFrontMatter(problemDir);
  const testCases = await readTestCases(path.join(problemDir, 'test_cases'));

  const staticAnalysisTestCaseResult = await judgeByStaticAnalysis(params.cwd, problemMarkdownFrontMatter);
  if (staticAnalysisTestCaseResult) {
    printTestCaseResult({ testCaseId: testCases[0]?.id ?? 'prebuild', ...staticAnalysisTestCaseResult });
    return;
  }

  const originalMainFilePath = await findEntryPointFile(params.cwd, params.language);
  if (!originalMainFilePath) {
    printTestCaseResult({
      testCaseId: testCases[0]?.id ?? 'prebuild',
      decisionCode: DecisionCode.MISSING_REQUIRED_SUBMISSION_FILE_ERROR,
      stderr: `main file not found${params.language ? `: language: ${params.language}` : ''}`,
    });
    return;
  }

  const languageDefinition = findLanguageDefinitionByPath(originalMainFilePath);
  if (!languageDefinition) {
    printTestCaseResult({
      testCaseId: testCases[0]?.id ?? 'prebuild',
      decisionCode: DecisionCode.WRONG_ANSWER,
      stderr: 'unsupported language',
    });
    return;
  }

  // `CI` changes affects Chainlit. `FORCE_COLOR` affects Bun.
  const env = { ...process.env, CI: '', FORCE_COLOR: '0' };

  let prebuiltMainFilePath: string | undefined;

  if (languageDefinition.prebuild) {
    try {
      await languageDefinition.prebuild(params.cwd);
      prebuiltMainFilePath = await findEntryPointFile(params.cwd, params.language);
    } catch (error) {
      console.error('prebuild error', error);

      printTestCaseResult({
        testCaseId: testCases[0]?.id ?? 'prebuild',
        decisionCode: DecisionCode.BUILD_ERROR,
        stderr: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  const mainFilePath = prebuiltMainFilePath ?? originalMainFilePath;

  if (languageDefinition.buildCommand) {
    try {
      const buildCommand = languageDefinition.buildCommand(mainFilePath);

      const buildSpawnResult = spawnSyncWithTimeout(
        buildCommand[0],
        buildCommand.slice(1),
        { cwd: params.cwd, encoding: 'utf8', env },
        BUILD_TIMEOUT_SECONDS
      );

      let decisionCode: DecisionCode = DecisionCode.ACCEPTED;

      if (buildSpawnResult.status !== 0) {
        decisionCode = DecisionCode.BUILD_ERROR;
      } else if (buildSpawnResult.timeSeconds > BUILD_TIMEOUT_SECONDS) {
        decisionCode = DecisionCode.BUILD_TIME_LIMIT_EXCEEDED;
      } else if (
        buildSpawnResult.stdout.length > MAX_STDOUT_LENGTH ||
        buildSpawnResult.stderr.length > MAX_STDOUT_LENGTH
      ) {
        decisionCode = DecisionCode.BUILD_OUTPUT_SIZE_LIMIT_EXCEEDED;
      }

      if (decisionCode !== DecisionCode.ACCEPTED) {
        printTestCaseResult({
          testCaseId: testCases[0]?.id ?? 'build',
          decisionCode,
          exitStatus: buildSpawnResult.status ?? undefined,
          stdout: buildSpawnResult.stdout.slice(0, MAX_STDOUT_LENGTH) || undefined,
          stderr: buildSpawnResult.stderr.slice(0, MAX_STDOUT_LENGTH) || undefined,
          timeSeconds: buildSpawnResult.timeSeconds,
          memoryBytes: buildSpawnResult.memoryBytes,
        });
        return;
      }
    } catch (error) {
      console.error('build error', error);

      printTestCaseResult({
        testCaseId: testCases[0]?.id ?? 'build',
        decisionCode: DecisionCode.BUILD_ERROR,
        stderr: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  for (const testCase of testCases) {
    const timeoutSeconds =
      typeof problemMarkdownFrontMatter.timeLimitMs === 'number'
        ? problemMarkdownFrontMatter.timeLimitMs / 1000
        : JUDGE_DEFAULT_TIMEOUT_SECONDS;

    const command = languageDefinition.command(mainFilePath);

    const spawnResult = spawnSyncWithTimeout(
      command[0],
      command.slice(1),
      { cwd: params.cwd, encoding: 'utf8', input: testCase.stdin, env },
      timeoutSeconds
    );

    const outputFiles = await readOutputFiles(params.cwd, problemMarkdownFrontMatter.requiredOutputFilePaths ?? []);

    let decisionCode: DecisionCode = DecisionCode.ACCEPTED;

    if (spawnResult.status !== 0) {
      decisionCode = DecisionCode.RUNTIME_ERROR;
    } else if (spawnResult.timeSeconds > timeoutSeconds) {
      decisionCode = DecisionCode.TIME_LIMIT_EXCEEDED;
    } else if (spawnResult.memoryBytes > (problemMarkdownFrontMatter.memoryLimitByte ?? Number.POSITIVE_INFINITY)) {
      decisionCode = DecisionCode.MEMORY_LIMIT_EXCEEDED;
    } else if (spawnResult.stdout.length > MAX_STDOUT_LENGTH || spawnResult.stderr.length > MAX_STDOUT_LENGTH) {
      decisionCode = DecisionCode.OUTPUT_SIZE_LIMIT_EXCEEDED;
    } else if (outputFiles.length < (problemMarkdownFrontMatter.requiredOutputFilePaths?.length ?? 0)) {
      decisionCode = DecisionCode.MISSING_REQUIRED_OUTPUT_FILE_ERROR;
    } else if (!compareStdoutAsSpaceSeparatedTokens(spawnResult.stdout, testCase.stdout ?? '')) {
      decisionCode = DecisionCode.WRONG_ANSWER;
    }

    printTestCaseResult({
      testCaseId: testCase.id,
      decisionCode,
      exitStatus: spawnResult.status ?? undefined,
      stdin: testCase.stdin,
      stdout: spawnResult.stdout.slice(0, MAX_STDOUT_LENGTH) || undefined,
      stderr: spawnResult.stderr.slice(0, MAX_STDOUT_LENGTH) || undefined,
      timeSeconds: spawnResult.timeSeconds,
      memoryBytes: spawnResult.memoryBytes,
      outputFiles: outputFiles.length > 0 ? outputFiles : undefined,
    });

    if (decisionCode !== DecisionCode.ACCEPTED) break;
  }
}

/**
 * A preset debug function using stdin and stdout as test cases.
 *
 * @example
 * Create `debug.ts`:
 * ```ts
 * import { stdioDebugPreset } from 'judge-utils/presets/stdio';
 *
 * await stdioDebugPreset(import.meta.dirname);
 * ```
 *
 * Run with the required parameters:
 * ```bash
 * bun debug.ts '{ "cwd": "model_answers/java", "stdin": "1 2" }'
 * ```
 */
export async function stdioDebugPreset(problemDir: string): Promise<void> {
  const args = parseArgs(process.argv);
  const params = debugParamsSchema.parse(args.params);

  const problemMarkdownFrontMatter = await readProblemMarkdownFrontMatter(problemDir);

  const originalMainFilePath = await findEntryPointFile(params.cwd, params.language);
  if (!originalMainFilePath) {
    printTestCaseResult({
      testCaseId: 'prebuild',
      decisionCode: DecisionCode.MISSING_REQUIRED_SUBMISSION_FILE_ERROR,
      stderr: `main file not found${params.language ? `: language: ${params.language}` : ''}`,
    });
    return;
  }

  const languageDefinition = findLanguageDefinitionByPath(originalMainFilePath);
  if (!languageDefinition) {
    printTestCaseResult({
      testCaseId: 'prebuild',
      decisionCode: DecisionCode.WRONG_ANSWER,
      stderr: 'unsupported language',
    });
    return;
  }

  // `CI` changes affects Chainlit. `FORCE_COLOR` affects Bun.
  const env = { ...process.env, CI: '', FORCE_COLOR: '0' };

  let prebuiltMainFilePath: string | undefined;

  if (languageDefinition.prebuild) {
    try {
      await languageDefinition.prebuild(params.cwd);
      prebuiltMainFilePath = await findEntryPointFile(params.cwd, params.language);
    } catch (error) {
      console.error('prebuild error', error);

      printTestCaseResult({
        testCaseId: 'prebuild',
        decisionCode: DecisionCode.BUILD_ERROR,
        stderr: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  const mainFilePath = prebuiltMainFilePath ?? originalMainFilePath;

  if (languageDefinition.buildCommand) {
    try {
      const buildCommand = languageDefinition.buildCommand(mainFilePath);

      const buildSpawnResult = spawnSyncWithTimeout(
        buildCommand[0],
        buildCommand.slice(1),
        { cwd: params.cwd, encoding: 'utf8', env },
        BUILD_TIMEOUT_SECONDS
      );

      let decisionCode: DecisionCode = DecisionCode.ACCEPTED;

      if (buildSpawnResult.status !== 0) {
        decisionCode = DecisionCode.BUILD_ERROR;
      } else if (buildSpawnResult.timeSeconds > BUILD_TIMEOUT_SECONDS) {
        decisionCode = DecisionCode.BUILD_TIME_LIMIT_EXCEEDED;
      } else if (
        buildSpawnResult.stdout.length > MAX_STDOUT_LENGTH ||
        buildSpawnResult.stderr.length > MAX_STDOUT_LENGTH
      ) {
        decisionCode = DecisionCode.BUILD_OUTPUT_SIZE_LIMIT_EXCEEDED;
      }

      if (decisionCode !== DecisionCode.ACCEPTED) {
        printTestCaseResult({
          testCaseId: 'build',
          decisionCode,
          exitStatus: buildSpawnResult.status ?? undefined,
          stdout: buildSpawnResult.stdout.slice(0, MAX_STDOUT_LENGTH) || undefined,
          stderr: buildSpawnResult.stderr.slice(0, MAX_STDOUT_LENGTH) || undefined,
          timeSeconds: buildSpawnResult.timeSeconds,
          memoryBytes: buildSpawnResult.memoryBytes,
        });
        return;
      }
    } catch (error) {
      console.error('build error', error);

      printTestCaseResult({
        testCaseId: 'build',
        decisionCode: DecisionCode.BUILD_ERROR,
        stderr: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  {
    const timeoutSeconds = Math.max(
      DEBUG_DEFAULT_TIMEOUT_SECONDS,
      (problemMarkdownFrontMatter.timeLimitMs ?? 0) / 1000
    );

    const command = languageDefinition.command(mainFilePath);

    const spawnResult = spawnSyncWithTimeout(
      command[0],
      command.slice(1),
      { cwd: params.cwd, encoding: 'utf8', input: params.stdin, env },
      timeoutSeconds
    );

    const outputFiles = await readOutputFiles(params.cwd, problemMarkdownFrontMatter.requiredOutputFilePaths ?? []);

    let decisionCode: DecisionCode = DecisionCode.ACCEPTED;

    if (spawnResult.status !== 0) {
      decisionCode = DecisionCode.RUNTIME_ERROR;
    } else if (spawnResult.timeSeconds > timeoutSeconds) {
      decisionCode = DecisionCode.TIME_LIMIT_EXCEEDED;
    } else if (spawnResult.memoryBytes > (problemMarkdownFrontMatter.memoryLimitByte ?? Number.POSITIVE_INFINITY)) {
      decisionCode = DecisionCode.MEMORY_LIMIT_EXCEEDED;
    } else if (spawnResult.stdout.length > MAX_STDOUT_LENGTH || spawnResult.stderr.length > MAX_STDOUT_LENGTH) {
      decisionCode = DecisionCode.OUTPUT_SIZE_LIMIT_EXCEEDED;
    } else if (outputFiles.length < (problemMarkdownFrontMatter.requiredOutputFilePaths?.length ?? 0)) {
      decisionCode = DecisionCode.MISSING_REQUIRED_OUTPUT_FILE_ERROR;
    }

    printTestCaseResult({
      testCaseId: 'debug',
      decisionCode,
      exitStatus: spawnResult.status ?? undefined,
      stdin: params.stdin,
      stdout: spawnResult.stdout.slice(0, MAX_STDOUT_LENGTH) || undefined,
      stderr: spawnResult.stderr.slice(0, MAX_STDOUT_LENGTH) || undefined,
      timeSeconds: spawnResult.timeSeconds,
      memoryBytes: spawnResult.memoryBytes,
      outputFiles: outputFiles.length > 0 ? outputFiles : undefined,
    });
  }
}
