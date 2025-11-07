import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { parseArgs } from '../helpers/args.js';
import { spawnSyncWithTimeout } from '../helpers/childProcess.js';
import { readProblemMarkdownFrontMatter, readTestCases } from '../helpers/fs.js';
import { compareStdioAsSpaceSeparatedTokens } from '../helpers/stdio.js';
import { printTestCaseResult } from '../helpers/testCaseResult.js';
import { DecisionCode } from '../types/decisionCode.js';
import type { ProblemMarkdownFrontMatter } from '../types/problem.js';
import type { TestCaseResult } from '../types/testCaseResult.js';

const BUILD_TIMEOUT_SECONDS = 10;
const DEFAULT_TIMEOUT_SECONDS = 2;

const MAX_STDOUT_LENGTH = 50_000;

const paramsSchema = z.object({
  cwd: z.string(),
  buildCommand: z.tuple([z.string()], z.string()).optional(),
  command: z.tuple([z.string()], z.string()),
  env: z.record(z.string(), z.string()).optional(),
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

  if (params.buildCommand) {
    try {
      const buildSpawnResult = spawnSyncWithTimeout(
        params.buildCommand[0],
        params.buildCommand.slice(1),
        { cwd: params.cwd, encoding: 'utf8', env: params.env },
        BUILD_TIMEOUT_SECONDS
      );

      const baseTestCaseResult = {
        testCaseId: testCases[0]?.id ?? '',
        exitStatus: buildSpawnResult.status ?? 0,
        stdout: buildSpawnResult.stdout.slice(0, MAX_STDOUT_LENGTH),
        stderr: buildSpawnResult.stderr.slice(0, MAX_STDOUT_LENGTH),
        timeSeconds: buildSpawnResult.timeSeconds,
        memoryBytes: buildSpawnResult.memoryBytes,
      };

      if (buildSpawnResult.timeSeconds > BUILD_TIMEOUT_SECONDS) {
        printTestCaseResult({ ...baseTestCaseResult, decisionCode: DecisionCode.BUILD_TIME_LIMIT_EXCEEDED });
        return;
      }

      if (buildSpawnResult.stdout.length > MAX_STDOUT_LENGTH || buildSpawnResult.stderr.length > MAX_STDOUT_LENGTH) {
        printTestCaseResult({ ...baseTestCaseResult, decisionCode: DecisionCode.BUILD_OUTPUT_SIZE_LIMIT_EXCEEDED });
        return;
      }

      if (buildSpawnResult.status !== 0) {
        printTestCaseResult({ ...baseTestCaseResult, decisionCode: DecisionCode.BUILD_ERROR });
        return;
      }
    } catch (error) {
      console.error('build error', error);

      printTestCaseResult({
        testCaseId: testCases[0]?.id ?? '',
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

    const spawnResult = spawnSyncWithTimeout(
      params.command[0],
      params.command.slice(1),
      { cwd: params.cwd, encoding: 'utf8', input: testCase.stdin, env: params.env },
      timeoutSeconds
    );

    const testCaseResult: Pick<TestCaseResult, 'testCaseId' | 'outputFiles'> & Partial<TestCaseResult> = {
      testCaseId: testCase.id,
      decisionCode: DecisionCode.ACCEPTED,
      exitStatus: spawnResult.status ?? 0,
      stdin: testCase.stdin ?? '',
      stdout: spawnResult.stdout.slice(0, MAX_STDOUT_LENGTH),
      stderr: spawnResult.stderr.slice(0, MAX_STDOUT_LENGTH),
      timeSeconds: spawnResult.timeSeconds,
      memoryBytes: spawnResult.memoryBytes,
      outputFiles: [],
    };

    if (spawnResult.status !== 0) {
      testCaseResult.decisionCode = DecisionCode.RUNTIME_ERROR;
    } else if (spawnResult.timeSeconds > timeoutSeconds) {
      if (problemMarkdownFrontMatter.isManualScoringRequired) {
        testCaseResult.stderr = `時間制限内（${timeoutSeconds}秒）に終了しませんでした！\n意図した出力が表示されていない場合は、\nプログラムを修正・再提出してください。\n\nYour program TIMED OUT (+${timeoutSeconds} seconds)!\nIf intended output is not displayed,\nplease correct and re-submit your program.\n\n${spawnResult.stderr.trimEnd()}`;
      } else {
        testCaseResult.decisionCode = DecisionCode.TIME_LIMIT_EXCEEDED;
      }
      testCaseResult.timeSeconds = timeoutSeconds + 1e-3;
    } else if (spawnResult.memoryBytes > (problemMarkdownFrontMatter.memoryLimitByte ?? Number.POSITIVE_INFINITY)) {
      testCaseResult.decisionCode = DecisionCode.MEMORY_LIMIT_EXCEEDED;
    } else if (spawnResult.stdout.length > MAX_STDOUT_LENGTH || spawnResult.stderr.length > MAX_STDOUT_LENGTH) {
      testCaseResult.decisionCode = DecisionCode.OUTPUT_SIZE_LIMIT_EXCEEDED;
    } else if (
      !checkAndReadRequiredOutputFiles(
        params.cwd,
        problemMarkdownFrontMatter.requiredOutputFilePaths,
        testCaseResult.outputFiles
      )
    ) {
      testCaseResult.decisionCode = DecisionCode.MISSING_REQUIRED_OUTPUT_FILE_ERROR;
    } else if (!compareStdioAsSpaceSeparatedTokens(spawnResult.stdout, testCase.stdout ?? '')) {
      testCaseResult.decisionCode = DecisionCode.WRONG_ANSWER;
    }

    printTestCaseResult(testCaseResult);
  }
}

// copied from judge
// TODO: refactor
function checkAndReadRequiredOutputFiles(
  cwd: string,
  requiredOutputFilePaths: ProblemMarkdownFrontMatter['requiredOutputFilePaths'],
  outputFiles: TestCaseResult['outputFiles']
): boolean {
  let exists = true;
  for (const requiredOutputFilePath of requiredOutputFilePaths ?? []) {
    if (!fs.existsSync(path.join(cwd, requiredOutputFilePath))) {
      exists = false;
      continue;
    }

    const buffer = fs.readFileSync(path.join(cwd, requiredOutputFilePath));
    const utf8Text = buffer.toString('utf8');
    const isBinary = utf8Text.includes('\uFFFD');
    if (isBinary) {
      outputFiles.push({
        path: requiredOutputFilePath,
        encoding: 'base64',
        data: buffer.toString('base64'),
      });
    } else {
      outputFiles.push({
        path: requiredOutputFilePath,
        data: utf8Text,
      });
    }
  }
  return exists;
}
