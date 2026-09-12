import type { TestCaseResult } from '@exercode/problem-utils';
import { launch, type Browser, type CDPSession, type LaunchOptions, type Page } from 'puppeteer';

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
  // A native screenshot holds a context-wide mutex even after a timeout, blocking other pages.
  const session = await page.createCDPSession();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const screenshot = captureFullPagePng(page, session);
    const result = await (timeout === 0
      ? screenshot
      : Promise.race([
          screenshot,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`Screenshot capture timed out after ${timeout} ms`)), timeout);
          }),
        ]));
    return Buffer.from(result.data, 'base64');
  } finally {
    clearTimeout(timer);
    await session.detach().catch(() => {
      // Closing the page also detaches this session; preserve the capture outcome.
    });
  }
}

async function captureFullPagePng(page: Page, session: CDPSession) {
  const [{ cssContentSize }, scale] = await Promise.all([
    session.send('Page.getLayoutMetrics'),
    page.evaluate(() => window.devicePixelRatio),
  ]);
  // Device scale belongs to Puppeteer's session; carry it into the independent capture session.
  return session.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: true,
    clip: { ...cssContentSize, scale },
  });
}

/** Finds a required course control immediately and reports its selector when absent. */
export async function requirePageElement(page: Page, selector: string) {
  const element = await page.$(selector);
  if (!element) throw new Error(`要素が見つかりません: ${selector}`);
  return element;
}

/** Evaluates a program with shared window state and evaluation-local lexical declarations. */
export async function evaluateBrowserProgram(page: Page, source: string): Promise<unknown> {
  try {
    // oxlint-disable-next-line no-eval -- Separate lexical scopes prevent setup declarations from colliding with learner declarations.
    return await page.evaluate((program) => globalThis.eval(program), source);
  } catch (error) {
    // Presets expose the message as feedback; include the browser exception type there.
    throw error instanceof Error ? new Error(String(error), { cause: error }) : error;
  }
}
