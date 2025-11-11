import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { compareStdoutAsSpaceSeparatedTokens } from '../helpers/compareStdoutAsSpaceSeparatedTokens.js';
import { findMainFile } from '../helpers/findMainFile.js';
import { parseArgs } from '../helpers/parseArgs.js';
import { encodeFileForTestCaseResult, printTestCaseResult } from '../helpers/printTestCaseResult.js';
import { readProblemMarkdownFrontMatter } from '../helpers/readProblemMarkdownFrontMatter.js';
import { readTestCases } from '../helpers/readTestCases.js';
import { spawnSyncWithTimeout } from '../helpers/spawnSyncWithTimeout.js';
import { DecisionCode } from '../types/decisionCode.js';
import { languageIdToDefinition } from '../types/language.js';
import type { TestCaseResult } from '../types/testCaseResult.js';

const BUILD_TIMEOUT_SECONDS = 10;
const DEFAULT_TIMEOUT_SECONDS = 2;

const MAX_STDOUT_LENGTH = 50_000;

const paramsSchema = z.object({
  cwd: z.string(),
  language: z.union([z.string(), z.array(z.string())]).optional(),
});

/**
 * @example
 * ```ts
 * await stdioPreset(import.meta.dirname);
 * ```
 */
export async function stdioPreset(problemDir: string): Promise<void> {
  const args = parseArgs(process.argv);
  const params = paramsSchema.parse(args.params);

  const problemMarkdownFrontMatter = await readProblemMarkdownFrontMatter(problemDir);
  const testCases = await readTestCases(path.join(problemDir, 'test_cases'));

  const mainFilePath = await findMainFile(params.cwd, params.language);
  if (!mainFilePath) {
    printTestCaseResult({
      testCaseId: testCases[0]?.id ?? 'prebuild',
      decisionCode: DecisionCode.MISSING_REQUIRED_SUBMISSION_FILE_ERROR,
      stderr: `main file not found${params.language ? `: language: ${params.language}` : ''}`,
    });
    return;
  }

  const languageDefinition = Object.values(languageIdToDefinition).find((d) =>
    [d.fileExtension].flat().some((e) => mainFilePath.endsWith(e))
  );
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
          exitStatus: buildSpawnResult.status ?? 0,
          stdout: buildSpawnResult.stdout.slice(0, MAX_STDOUT_LENGTH),
          stderr: buildSpawnResult.stderr.slice(0, MAX_STDOUT_LENGTH),
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
        : DEFAULT_TIMEOUT_SECONDS;

    const command = languageDefinition.command(mainFilePath);

    const spawnResult = spawnSyncWithTimeout(
      command[0],
      command.slice(1),
      { cwd: params.cwd, encoding: 'utf8', input: testCase.stdin, env },
      timeoutSeconds
    );

    const outputFiles: TestCaseResult['outputFiles'] = [];
    for (const filePath of problemMarkdownFrontMatter.requiredOutputFilePaths ?? []) {
      try {
        const buffer = await fs.promises.readFile(path.join(params.cwd, filePath));
        outputFiles.push(encodeFileForTestCaseResult(filePath, buffer));
      } catch {
        // file not found
      }
    }

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
      exitStatus: spawnResult.status ?? 0,
      stdin: testCase.stdin ?? '',
      stdout: spawnResult.stdout.slice(0, MAX_STDOUT_LENGTH),
      stderr: spawnResult.stderr.slice(0, MAX_STDOUT_LENGTH),
      timeSeconds: spawnResult.timeSeconds,
      memoryBytes: spawnResult.memoryBytes,
      outputFiles,
    });
  }
}
