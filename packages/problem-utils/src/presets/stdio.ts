import fs from 'node:fs';
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
import {
  judgesTestCasesWithoutExpectations,
  readProblemMarkdownFrontMatter,
} from '../helpers/readProblemMarkdownFrontMatter.js';
import { readTestCases } from '../helpers/readTestCases.js';
import { spawnWithTimeout } from '../helpers/spawnWithTimeout.js';
import { EXAMPLE_TEST_CASE_ID_PATTERN, MAX_STDOUT_LENGTH } from '../helpers/stdioJudgeRules.js';
import {
  copyProblemDirToTemporaryRoot,
  forciblyRemoveDirectory,
  forciblyRemoveDirectorySync,
} from '../helpers/temporaryProblemDirCopy.js';
import { DecisionCode } from '../types/decisionCode.js';

const BUILD_TIMEOUT_SECONDS = 10;
const JUDGE_DEFAULT_TIMEOUT_SECONDS = 2;
const DEBUG_DEFAULT_TIMEOUT_SECONDS = 10;

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

  const problemMarkdownFrontMatter = await readProblemMarkdownFrontMatter(problemDir);
  const testCases = await readTestCases(path.join(problemDir, 'test_cases'));

  // Without an expectation, a case would accept any run; only custom harnesses may judge input-only
  // cases. A problem judged by manual scoring or the presence of required output files has an
  // expectation of its own. Checked before the static analysis so that an authoring error surfaces
  // regardless of the submission.
  if (!judgesTestCasesWithoutExpectations(problemMarkdownFrontMatter)) {
    for (const testCase of testCases) {
      if (testCase.output === undefined && !(await hasExpectedFiles(testCase.fileOutputPath))) {
        throw new Error(
          `test case ${testCase.id} needs an expected output (${testCase.id}.out or a non-empty ${testCase.id}.fout/)`
        );
      }
    }
  }

  const staticAnalysisTestCaseResult = await judgeByStaticAnalysis(args.cwd, problemMarkdownFrontMatter);
  if (staticAnalysisTestCaseResult) {
    printTestCaseResult({ testCaseId: testCases[0]?.id ?? 'prebuild', ...staticAnalysisTestCaseResult });
    return;
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
    const buildCommand = languageDefinition.buildCommand(mainFilePath);

    // The build reports the submission's failures in its result; what `spawnWithTimeout` throws is
    // the judge's own failure and ends the run without a verdict.
    const buildSpawnResult = await spawnWithTimeout(
      buildCommand[0],
      buildCommand.slice(1),
      { cwd: args.cwd, env },
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
        cpuTimeSeconds: buildSpawnResult.cpuTimeSeconds,
        memoryBytes: buildSpawnResult.memoryBytes,
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

    const spawnResult = await spawnWithTimeout(
      command[0],
      command.slice(1),
      { cwd: args.cwd, stdin: testCase.input, env },
      timeoutSeconds
    );

    let outputFiles = await readOutputFiles(args.cwd, problemMarkdownFrontMatter.requiredOutputFilePaths ?? []);

    // calculate decision
    let decisionCode: DecisionCode = DecisionCode.ACCEPTED;
    let judgementError: string | undefined;

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
      try {
        const judgement = await judgeAgainstExpectations({
          stdout: spawnResult.stdout,
          expectedStdout: testCase.output,
          fileOutputPath: testCase.fileOutputPath,
          cwd: args.cwd,
          outputFiles,
        });
        if (!judgement.matches) decisionCode = DecisionCode.WRONG_ANSWER;
        outputFiles = judgement.outputFiles;
      } catch (error) {
        // An authoring error (e.g. an oversized expected file) is reported per case, like the command preset does.
        decisionCode = DecisionCode.RUNTIME_ERROR;
        judgementError = error instanceof Error ? error.message : String(error);
      }
    }

    printTestCaseResult({
      testCaseId: testCase.id,
      decisionCode,
      exitStatus: spawnResult.status ?? undefined,
      stdin: testCase.input,
      stdout: spawnResult.stdout.slice(0, MAX_STDOUT_LENGTH) || undefined,
      stderr: (judgementError ?? spawnResult.stderr).slice(0, MAX_STDOUT_LENGTH) || undefined,
      timeSeconds: spawnResult.timeSeconds,
      cpuTimeSeconds: spawnResult.cpuTimeSeconds,
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
 * temporary directory where it is built and run together with `_shared.fin/` and the first example
 * case's `.fin/`; files the program writes are reported only through `requiredOutputFilePaths`.
 * Callers that own and remove the working directory can set `disposableWorkingDirectory` to run
 * directly there; they are responsible for cleanup even when the harness is terminated.
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
export async function stdioDebugPreset(
  problemDir: string,
  options: { disposableWorkingDirectory?: boolean } = {}
): Promise<void> {
  const args = parseArgs(process.argv);
  if (!args.cwd) throw new Error('cwd argument required');
  const params = debugParamsSchema.parse(args.params);

  // The judge server already owns and removes its per-request answer directory.
  if (options.disposableWorkingDirectory) {
    await debugInWorkingDirectory(problemDir, args.cwd, params);
    return;
  }

  // Everything (build, input files, run) happens in a disposable copy of the answer directory, so
  // the developer's files are never touched and whatever the submission leaves behind goes with it.
  // The copy keeps the directory hierarchy and links every ancestor `node_modules`, so packages the
  // answer resolves from its parents still resolve.
  // A terminated debug run must not leave the copy behind; `finally` does not run on a signal, so
  // the handlers learn the root as soon as it is created and stay until it is removed.
  let tempRoot: string | undefined;
  const removeOnSignal = (): void => {
    if (tempRoot !== undefined) forciblyRemoveDirectorySync(tempRoot);
    process.exit(1);
  };
  process.once('SIGINT', removeOnSignal);
  process.once('SIGTERM', removeOnSignal);
  try {
    const copy = await copyProblemDirToTemporaryRoot(args.cwd, { onTempRootCreated: (root) => (tempRoot = root) });
    await debugInWorkingDirectory(problemDir, copy.copiedProblemDir, params);
  } finally {
    if (tempRoot !== undefined) await forciblyRemoveDirectory(tempRoot);
    process.off('SIGINT', removeOnSignal);
    process.off('SIGTERM', removeOnSignal);
  }
}

async function debugInWorkingDirectory(problemDir: string, cwd: string, params: DebugParams): Promise<void> {
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
    const buildCommand = languageDefinition.buildCommand(mainFilePath);

    // The build reports the submission's failures in its result; what `spawnWithTimeout` throws is
    // the judge's own failure and ends the run without a verdict.
    const buildSpawnResult = await spawnWithTimeout(
      buildCommand[0],
      buildCommand.slice(1),
      { cwd, env },
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
        cpuTimeSeconds: buildSpawnResult.cpuTimeSeconds,
        memoryBytes: buildSpawnResult.memoryBytes,
      });
      return;
    }
  }

  // A debug run has no test case of its own: it gets the shared input files and the `.fin/` of the
  // first example case (the cases a learner may see), placed the way the judge does. Hidden cases'
  // input files are never handed to learner code.
  const testCases = await readTestCases(path.join(problemDir, 'test_cases'));
  if (testCases.shared?.fileInputPath) await copyTestCaseFileInput(testCases.shared.fileInputPath, cwd);
  const exampleFileInputPath = testCases.find(
    (testCase) => EXAMPLE_TEST_CASE_ID_PATTERN.test(testCase.id) && testCase.fileInputPath
  )?.fileInputPath;
  if (exampleFileInputPath) {
    await copyTestCaseFileInput(exampleFileInputPath, cwd);
  } else if (testCases.some((testCase) => testCase.fileInputPath)) {
    console.error('debug: no example test case has input files, so the program runs without them');
  }

  const timeoutSeconds = Math.max(DEBUG_DEFAULT_TIMEOUT_SECONDS, (problemMarkdownFrontMatter.timeLimitMs ?? 0) / 1000);

  const command = languageDefinition.command(mainFilePath);

  const spawnResult = await spawnWithTimeout(
    command[0],
    command.slice(1),
    { cwd, stdin: params.stdin, env },
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
    cpuTimeSeconds: spawnResult.cpuTimeSeconds,
    memoryBytes: spawnResult.memoryBytes,
    outputFiles: outputFiles.length > 0 ? outputFiles : undefined,
  });
}
