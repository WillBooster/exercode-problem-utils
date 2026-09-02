import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { cleanWorkingDirectory, snapshotWorkingDirectory } from '../helpers/cleanWorkingDirectory.js';
import { compareExpectedOutputFiles, mergeComparisonOutputFiles } from '../helpers/compareExpectedOutputFiles.js';
import { compareStdoutAsSpaceSeparatedTokens } from '../helpers/compareStdoutAsSpaceSeparatedTokens.js';
import { copyTestCaseFileInput } from '../helpers/copyTestCaseFileInput.js';
import { findEntryPointFile } from '../helpers/findEntryPointFile.js';
import { findLanguageDefinitionByPath } from '../helpers/findLanguageDefinitionByPath.js';
import { judgeByStaticAnalysis } from '../helpers/judgeByStaticAnalysis.js';
import { parseArgs } from '../helpers/parseArgs.js';
import { printTestCaseResult } from '../helpers/printTestCaseResult.js';
import { readOutputFiles } from '../helpers/readOutputFiles.js';
import { copyWithoutFollowingSymlinks } from '../helpers/safeFs.js';
import { makeAccessibleToSandboxUser } from '../helpers/sandboxUser.js';
import { judgesWithoutTestCases, readProblemMarkdownFrontMatter } from '../helpers/readProblemMarkdownFrontMatter.js';
import { readTestCases } from '../helpers/readTestCases.js';
import { spawnSyncWithTimeout } from '../helpers/spawnSyncWithTimeout.js';
import { forciblyRemoveDirectory } from '../helpers/temporaryProblemDirCopy.js';
import { DecisionCode } from '../types/decisionCode.js';

const BUILD_TIMEOUT_SECONDS = 10;
const JUDGE_DEFAULT_TIMEOUT_SECONDS = 2;
const DEBUG_DEFAULT_TIMEOUT_SECONDS = 10;

const MAX_STDOUT_LENGTH = 50_000;

const judgeParamsSchema = z.object({
  language: z.union([z.string(), z.array(z.string())]).optional(),
});

const debugParamsSchema = judgeParamsSchema.extend({
  stdin: z.string().optional(),
});

type DebugParams = z.infer<typeof debugParamsSchema>;

/**
 * A preset judge function using stdin and stdout as test cases.
 *
 * A standard stdio problem must NOT commit a `judge.ts` that only calls this preset: the Exercode
 * server applies this preset automatically when `judge.ts` is absent, and committed copies would
 * drift from the server's defaults.
 *
 * @example
 * Run in a problem directory without `judge.ts`:
 * ```bash
 * bun x exercode-problem judge model_answers/java
 * ```
 *
 * Run with the optional parameters:
 * ```bash
 * bun x exercode-problem judge model_answers/java '{ "language": "javascript" }'
 * ```
 */
export async function stdioJudgePreset(problemDir: string): Promise<void> {
  const args = parseArgs(process.argv);
  if (!args.cwd) throw new Error('cwd argument required');
  const params = judgeParamsSchema.parse(args.params);

  // The sandboxed submission must read its sources and write build/run outputs in its directory.
  makeAccessibleToSandboxUser(args.cwd);

  const problemMarkdownFrontMatter = await readProblemMarkdownFrontMatter(problemDir);
  const testCases = await readTestCases(path.join(problemDir, 'test_cases'));
  const staticAnalysisTestCaseResult = await judgeByStaticAnalysis(args.cwd, problemMarkdownFrontMatter);
  if (staticAnalysisTestCaseResult) {
    printTestCaseResult({ testCaseId: testCases[0]?.id ?? 'prebuild', ...staticAnalysisTestCaseResult });
    return;
  }

  // Without an expectation, a case would accept any run; only custom harnesses may judge input-only
  // cases. A problem judged by static analysis, manual scoring or the presence of required output
  // files has an expectation of its own.
  if (
    !judgesWithoutTestCases(problemMarkdownFrontMatter) &&
    !problemMarkdownFrontMatter.requiredOutputFilePaths?.length
  ) {
    for (const testCase of testCases) {
      if (testCase.output === undefined && !(await hasExpectedFiles(testCase.fileOutputPath))) {
        throw new Error(
          `test case ${testCase.id} needs an expected output (${testCase.id}.out or a non-empty ${testCase.id}.fout/)`
        );
      }
    }
  }

  const originalMainFilePath = await findEntryPointFile(args.cwd, params.language);
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
      await languageDefinition.prebuild(args.cwd);
      prebuiltMainFilePath = await findEntryPointFile(args.cwd, params.language);
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
        { cwd: args.cwd, encoding: 'utf8', env },
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

  const cwdSnapshot = await snapshotWorkingDirectory(args.cwd);

  if (testCases.length === 0) {
    printTestCaseResult({ testCaseId: 'default', decisionCode: DecisionCode.ACCEPTED });
  }

  for (const testCase of testCases) {
    // prepare test case
    if (testCases.shared?.fileInputPath) await copyTestCaseFileInput(testCases.shared.fileInputPath, args.cwd);
    if (testCase.fileInputPath) await copyTestCaseFileInput(testCase.fileInputPath, args.cwd);

    // run
    const timeoutSeconds =
      typeof problemMarkdownFrontMatter.timeLimitMs === 'number'
        ? problemMarkdownFrontMatter.timeLimitMs / 1000
        : JUDGE_DEFAULT_TIMEOUT_SECONDS;

    const command = languageDefinition.command(mainFilePath);

    const spawnResult = spawnSyncWithTimeout(
      command[0],
      command.slice(1),
      { cwd: args.cwd, encoding: 'utf8', input: testCase.input, env },
      timeoutSeconds
    );

    let outputFiles = await readOutputFiles(args.cwd, problemMarkdownFrontMatter.requiredOutputFilePaths ?? []);

    // calculate decision
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
    } else {
      // Check stdout and files independently so a result carries every mismatch, not just the first.
      if (testCase.output !== undefined && !compareStdoutAsSpaceSeparatedTokens(spawnResult.stdout, testCase.output)) {
        decisionCode = DecisionCode.WRONG_ANSWER;
      }
      if (testCase.fileOutputPath) {
        const comparison = await compareExpectedOutputFiles(args.cwd, testCase.fileOutputPath);
        if (!comparison.matches) {
          decisionCode = DecisionCode.WRONG_ANSWER;
          outputFiles = mergeComparisonOutputFiles(outputFiles, comparison);
        }
      }
    }

    printTestCaseResult({
      testCaseId: testCase.id,
      decisionCode,
      exitStatus: spawnResult.status ?? undefined,
      stdin: testCase.input,
      stdout: spawnResult.stdout.slice(0, MAX_STDOUT_LENGTH) || undefined,
      stderr: spawnResult.stderr.slice(0, MAX_STDOUT_LENGTH) || undefined,
      timeSeconds: spawnResult.timeSeconds,
      memoryBytes: spawnResult.memoryBytes,
      outputFiles: outputFiles.length > 0 ? outputFiles : undefined,
    });

    // clean up
    await cleanWorkingDirectory(args.cwd, cwdSnapshot);

    if (decisionCode !== DecisionCode.ACCEPTED) break;
  }
}

async function hasExpectedFiles(fileOutputPath: string | undefined): Promise<boolean> {
  if (fileOutputPath === undefined) return false;
  const dirents = await fs.promises.readdir(fileOutputPath, { withFileTypes: true, recursive: true });
  return dirents.some((dirent) => dirent.isFile());
}

/**
 * A preset debug function using stdin and stdout as test cases. The answer directory is copied to a
 * temporary directory where it is built and run together with `_shared.fin/` and the first test
 * case's `.fin/`; files the program writes are reported only through `requiredOutputFilePaths`.
 *
 * A standard stdio problem must NOT commit a `debug.ts` that only calls this preset: the Exercode
 * server applies this preset automatically when `debug.ts` is absent, and committed copies would
 * drift from the server's defaults.
 *
 * @example
 * Run in a problem directory without `debug.ts`:
 * ```bash
 * bun x exercode-problem debug model_answers/java '{ "stdin": "1 2" }'
 * ```
 */
export async function stdioDebugPreset(problemDir: string): Promise<void> {
  const args = parseArgs(process.argv);
  if (!args.cwd) throw new Error('cwd argument required');
  const params = debugParamsSchema.parse(args.params);

  // Everything (build, input files, run) happens in a disposable copy of the answer directory, so
  // the developer's files are never touched and whatever the submission leaves behind goes with it.
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'exercode-debug-'));
  try {
    await copyWithoutFollowingSymlinks(args.cwd, cwd);
    await debugInTemporaryCopy(problemDir, cwd, params);
  } finally {
    await forciblyRemoveDirectory(cwd);
  }
}

async function debugInTemporaryCopy(problemDir: string, cwd: string, params: DebugParams): Promise<void> {
  // The sandboxed submission must read its sources and write build/run outputs in its directory.
  makeAccessibleToSandboxUser(cwd);

  const problemMarkdownFrontMatter = await readProblemMarkdownFrontMatter(problemDir);

  const originalMainFilePath = await findEntryPointFile(cwd, params.language);
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
      await languageDefinition.prebuild(cwd);
      prebuiltMainFilePath = await findEntryPointFile(cwd, params.language);
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
        { cwd, encoding: 'utf8', env },
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

  // A debug run has no test case of its own: it gets the shared input files and the first test
  // case's `.fin/` (the sorted order puts `example_*` before `test_*`), placed the way the judge does.
  const testCases = await readTestCases(path.join(problemDir, 'test_cases'));
  if (testCases.shared?.fileInputPath) await copyTestCaseFileInput(testCases.shared.fileInputPath, cwd);
  if (testCases[0]?.fileInputPath) await copyTestCaseFileInput(testCases[0].fileInputPath, cwd);

  {
    const timeoutSeconds = Math.max(
      DEBUG_DEFAULT_TIMEOUT_SECONDS,
      (problemMarkdownFrontMatter.timeLimitMs ?? 0) / 1000
    );

    const command = languageDefinition.command(mainFilePath);

    const spawnResult = spawnSyncWithTimeout(
      command[0],
      command.slice(1),
      { cwd, encoding: 'utf8', input: params.stdin, env },
      timeoutSeconds
    );

    const outputFiles = await readOutputFiles(cwd, problemMarkdownFrontMatter.requiredOutputFilePaths ?? []);

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
