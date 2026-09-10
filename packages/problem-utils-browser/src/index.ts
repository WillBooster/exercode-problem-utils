import {
  DecisionCode,
  parseArgs,
  printTestCaseResult,
  startHttpServer,
  type TestCaseResult,
} from '@exercode/problem-utils';
import { chromium, type Browser, type BrowserContextOptions, type LaunchOptions, type Page } from 'playwright-core';

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
      const result = await test(page);
      if (options.screenshotOnFailure && result.decisionCode !== DecisionCode.ACCEPTED) {
        result.outputFiles = [...(result.outputFiles ?? []), await captureScreenshot(page)];
      }
      printTestCaseResult({ testCaseId, ...result });
      if (result.decisionCode !== DecisionCode.ACCEPTED) break;
    }
  } finally {
    await browser.close();
  }
}

/** Launches the Chromium installed for this Playwright version. */
export async function launchBrowser(options: LaunchOptions = {}): Promise<Browser> {
  return chromium.launch({ headless: true, ...options });
}

/** Encodes a page screenshot as a judge output file. */
export async function captureScreenshot(
  page: Page,
  filename = 'screenshot_received.png'
): Promise<NonNullable<TestCaseResult['outputFiles']>[number]> {
  const screenshot = await page.screenshot({ fullPage: true });
  return { path: filename, data: screenshot.toString('base64'), encoding: 'base64' };
}
