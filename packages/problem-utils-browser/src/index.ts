import { stripVTControlCharacters } from 'node:util';
import {
  DecisionCode,
  parseArgs,
  printTestCaseResult,
  startLocalHttpServer,
  type TestCaseResult,
} from '@exercode/problem-utils';
import type { BrowserContextOptions, LaunchOptions, Page } from 'playwright-core';

import { captureScreenshot, launchBrowser } from './browser.js';

export { captureScreenshot, launchBrowser, requirePageElement } from './browser.js';
export {
  htmlJudgePreset,
  captureHtmlBodySnapshot,
  captureHtmlScreenshotPair,
  createHtmlServedDirectory,
  type HtmlJudgePresetOptions,
  type HtmlScreenshotTarget,
  type ServedDirectory,
} from './html.js';

export type { Browser, BrowserContext, BrowserContextOptions, LaunchOptions, Locator, Page } from 'playwright-core';

export type BrowserJudgeResult = Omit<TestCaseResult, 'testCaseId'>;
export type BrowserJudgeTestCase = readonly [string, (page: Page) => Promise<BrowserJudgeResult>];

export interface BrowserJudgePresetOptions {
  testCases: readonly BrowserJudgeTestCase[];
  timeoutMs?: number;
  directoryPath?: string;
  initializePage?: (page: Page) => void | Promise<void>;
  afterTests?: (page: Page) => void | Promise<void>;
  entryPath?: string;
  navigationOptions?: Parameters<Page['goto']>[1];
  launchOptions?: LaunchOptions;
  contextOptions?: BrowserContextOptions;
  /** Capture the page as an output file when a test fails. */
  screenshotOnFailure?: boolean;
}

/** Runs browser checks against the submitted directory and emits judge stream results. */
export async function browserJudgePreset(options: BrowserJudgePresetOptions): Promise<void> {
  try {
    await runBrowserJudge(options);
  } catch (error) {
    try {
      if (error instanceof Error) {
        const message = stripVTControlCharacters(error.message);
        if (message !== error.message) error.message = message;
        if (error.stack) {
          const stack = stripVTControlCharacters(error.stack);
          if (stack !== error.stack) error.stack = stack;
        }
      }
    } catch {
      // A read-only diagnostic must not replace the original failure.
    }
    throw error;
  }
}

async function runBrowserJudge(options: BrowserJudgePresetOptions): Promise<void> {
  const args = parseArgs(process.argv);
  const directoryPath = options.directoryPath ?? args.cwd;
  if (!directoryPath) throw new Error('cwd argument required');
  await using server = await startLocalHttpServer(directoryPath);
  const browser = await launchBrowser(options.launchOptions);
  try {
    const context = await browser.newContext(options.contextOptions);
    const page = await context.newPage();
    page.setDefaultTimeout(options.timeoutMs ?? 5000);
    await options.initializePage?.(page);
    await page.goto(new URL(options.entryPath ?? '/', server.url).href, {
      waitUntil: 'domcontentloaded',
      ...options.navigationOptions,
    });
    for (const [testCaseId, test] of options.testCases) {
      const result = { ...(await test(page)) };
      if (options.screenshotOnFailure && result.decisionCode !== DecisionCode.ACCEPTED) {
        try {
          result.outputFiles = [...(result.outputFiles ?? []), await captureScreenshot(page)];
        } catch (error) {
          const message = `Screenshot capture failed: ${error instanceof Error ? error.message : String(error)}`;
          result.stderr = result.stderr ? `${result.stderr}\n${message}` : message;
        }
      }
      if (result.stderr) result.stderr = stripVTControlCharacters(result.stderr);
      printTestCaseResult({ testCaseId, ...result });
      if (result.decisionCode !== DecisionCode.ACCEPTED) break;
    }
    await options.afterTests?.(page);
  } finally {
    await browser.close();
  }
}

export { javascriptJudgePreset, type JavascriptJudgePresetOptions } from './javascript.js';
export { javascriptDomJudgePreset } from './javascriptDom.js';
export { captureTomcatScreenshots, verifyTomcatHtml, verifyTomcatPath } from './tomcat.js';
