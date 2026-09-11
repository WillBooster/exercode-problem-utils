import fs from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { launchBrowser } from './browser.js';
import { startEmptyPageServer } from './emptyPageServer.js';
import path from 'node:path';

import { DecisionCode } from '@exercode/problem-utils';
import { commandJudgePreset } from '@exercode/problem-utils/presets/command';

interface TestCase {
  id: string;
  input?: string;
  output?: string;
}

export interface JavascriptJudgePresetOptions {
  initializeAndVerifyDom?: boolean;
  waitForConsoleIdle?: boolean;
}

export async function javascriptJudgePreset(
  problemDirectoryPath: string,
  options: JavascriptJudgePresetOptions = {}
): Promise<void> {
  await commandJudgePreset<TestCase>(problemDirectoryPath, {
    readTestCases,
    runCommand: ({ cwd, testCase, timeLimitSeconds }) => runInBrowser({ cwd, testCase, timeLimitSeconds }, options),
    test: ({ runResult, testCase }) =>
      normalize(runResult.stdout) === normalize(testCase.output ?? '')
        ? { decisionCode: DecisionCode.ACCEPTED }
        : { decisionCode: DecisionCode.WRONG_ANSWER },
  });
}

async function readTestCases(problemDir: string): Promise<TestCase[]> {
  const testCasesDir = path.join(problemDir, 'test_cases');
  const files = await fs.readdir(testCasesDir);
  const ids = [...new Set(files.map((file) => path.parse(file).name))].toSorted();

  return await Promise.all(
    ids.map(async (id) => ({
      id,
      input: await readOptionalTextFile(path.join(testCasesDir, `${id}.in`)),
      output: await readOptionalTextFile(path.join(testCasesDir, `${id}.out`)),
    }))
  );
}

async function runInBrowser(
  context: { cwd: string; testCase: TestCase; timeLimitSeconds: number },
  options: JavascriptJudgePresetOptions
): Promise<{
  stdin: string;
  stdout: string;
  stderr: string;
  status: number;
  timeSeconds: number;
  memoryBytes: number;
}> {
  const source = await readSubmissionSource(context.cwd);
  await using server = await startEmptyPageServer();
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const stdout: string[] = [];
    const stderr: string[] = [];
    let pageErrorOccurred = false;
    let isRunning = true;

    page.on('console', (message) => {
      isRunning = true;
      if (message.type() === 'log') {
        stdout.push(message.text());
        return;
      }
      if (message.type() === 'error') {
        stderr.push(message.text());
      }
    });
    page.on('pageerror', (error) => {
      isRunning = true;
      pageErrorOccurred = true;
      stderr.push(error instanceof Error ? error.message : String(error));
    });

    const runStartedAt = Date.now();
    let status = 0;

    try {
      await page.goto(server.url, { waitUntil: 'load' });

      if (context.testCase.input) {
        await page.evaluate(context.testCase.input);
      }

      await withTimeout(
        () =>
          page.evaluate(
            options.initializeAndVerifyDom
              ? `
          window.initializeTest?.();
          ${source}
          window.verifyDom?.();
        `
              : source
          ),
        context.timeLimitSeconds
      );

      if (options.waitForConsoleIdle) {
        while (isRunning) {
          isRunning = false;
          await sleep(1000);
        }
      }
      if (pageErrorOccurred) {
        status = 1;
      }
    } catch (error) {
      status = 1;
      stderr.push(error instanceof Error ? error.message : String(error));
    } finally {
      await page.close();
    }

    const elapsedSeconds =
      status === 0
        ? Math.min((Date.now() - runStartedAt) / 1000, context.timeLimitSeconds)
        : context.timeLimitSeconds + 1;

    return {
      stdin: context.testCase.input ?? '',
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
      status,
      timeSeconds: elapsedSeconds,
      memoryBytes: 0,
    };
  } finally {
    await browser.close();
  }
}

async function readSubmissionSource(cwd: string): Promise<string> {
  for (const filePath of ['main.mjs', 'main.js']) {
    try {
      return await fs.readFile(path.join(cwd, filePath), 'utf8');
    } catch {
      // Continue.
    }
  }

  throw new Error('main.mjs or main.js not found');
}

async function readOptionalTextFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function normalize(value: string): string {
  return value.replaceAll('\r\n', '\n').trimEnd();
}

async function withTimeout<T>(task: () => Promise<T>, timeLimitSeconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`time limit exceeded: ${timeLimitSeconds}s`)),
          timeLimitSeconds * 1000
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
