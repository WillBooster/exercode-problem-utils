import type { TestCaseResult } from '@exercode/problem-utils';
import { chromium, type Browser, type LaunchOptions, type Page } from 'playwright-core';

/** Launches the Chromium installed for this Playwright version. */
export async function launchBrowser(options: LaunchOptions = {}): Promise<Browser> {
  return chromium.launch({
    headless: true,
    chromiumSandbox: !process.env.CI && process.env.WB_DOCKER !== '1',
    ...options,
  });
}

/** Encodes a page screenshot as a judge output file. */
export async function captureScreenshot(
  page: Page,
  filename = 'screenshot_received.png'
): Promise<NonNullable<TestCaseResult['outputFiles']>[number]> {
  const screenshot = await page.screenshot({ fullPage: true });
  return { path: filename, data: screenshot.toString('base64'), encoding: 'base64' };
}
