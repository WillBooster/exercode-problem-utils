import {
  DecisionCode,
  parseArgs,
  printTestCaseResult,
  startHttpServer,
  type TestCaseResult,
} from '@exercode/problem-utils';
import type { BrowserContextOptions, LaunchOptions, Page } from 'playwright-core';

import { captureScreenshot, launchBrowser } from './browser.js';

export { captureScreenshot, launchBrowser } from './browser.js';
export {
  htmlJudgePreset,
  captureHtmlBodySnapshot,
  captureHtmlScreenshot,
  createHtmlServedDirectory,
  type HtmlJudgePresetOptions,
  type ServedDirectory,
} from './html.js';

export type { Browser, BrowserContext, BrowserContextOptions, LaunchOptions, Locator, Page } from 'playwright-core';

export type BrowserJudgeResult = Omit<TestCaseResult, 'testCaseId'>;
export type BrowserJudgeTestCase = readonly [string, (page: Page) => Promise<BrowserJudgeResult>];

export interface BrowserJudgePresetOptions {
  testCases: readonly BrowserJudgeTestCase[];
  timeoutMs?: number;
  launchOptions?: LaunchOptions;
  contextOptions?: BrowserContextOptions;
  /** Capture the page as an output file when a test fails. */
  screenshotOnFailure?: boolean;
}

/** Runs browser checks against the submitted directory and emits judge stream results. */
export async function browserJudgePreset(options: BrowserJudgePresetOptions): Promise<void> {
  const args = parseArgs(process.argv);
  if (!args.cwd) throw new Error('cwd argument required');
  await using server = startHttpServer(args.cwd);
  const browser = await launchBrowser(options.launchOptions);
  try {
    const context = await browser.newContext(options.contextOptions);
    const page = await context.newPage();
    page.setDefaultTimeout(options.timeoutMs ?? 5000);
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
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
      printTestCaseResult({ testCaseId, ...result });
      if (result.decisionCode !== DecisionCode.ACCEPTED) break;
    }
  } finally {
    await browser.close();
  }
}
