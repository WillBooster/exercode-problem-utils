import type { TestCaseResult } from '@exercode/problem-utils';
import { launch, type Browser, type LaunchOptions, type Page } from 'puppeteer';

/** Launches the Chrome headless shell installed for this Puppeteer version. */
export async function launchBrowser(options: LaunchOptions = {}): Promise<Browser> {
  return launch({
    browser: 'chrome',
    headless: 'shell',
    defaultViewport: { width: 1280, height: 720 },
    ...options,
    args: [
      ...(process.env.CI || process.env.WB_DOCKER === '1' ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
      ...(options.args ?? []),
    ],
  });
}

/** Encodes a page screenshot as a judge output file. */
export async function captureScreenshot(
  page: Page,
  filename = 'screenshot_received.png'
): Promise<NonNullable<TestCaseResult['outputFiles']>[number]> {
  const screenshot = await capturePngScreenshot(page);
  return { path: filename, data: screenshot.toString('base64'), encoding: 'base64' };
}

/** Captures a full-page PNG within the page's configured default timeout. */
export async function capturePngScreenshot(page: Page): Promise<Buffer> {
  const timeout = page.getDefaultTimeout();
  const screenshot = page.screenshot({ fullPage: true, type: 'png' });
  if (timeout === 0) return Buffer.from(await screenshot);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return Buffer.from(
      await Promise.race([
        screenshot,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Screenshot capture timed out after ${timeout} ms`)), timeout);
        }),
      ])
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Finds a required course control immediately and reports its selector when absent. */
export async function requirePageElement(page: Page, selector: string) {
  const element = await page.$(selector);
  if (!element) throw new Error(`要素が見つかりません: ${selector}`);
  return element;
}

/** Evaluates a program with shared window state and evaluation-local lexical declarations. */
export async function evaluateBrowserProgram(page: Page, source: string): Promise<unknown> {
  // oxlint-disable-next-line no-eval -- Separate lexical scopes prevent setup declarations from colliding with learner declarations.
  return page.evaluate((program) => globalThis.eval(program), source);
}
