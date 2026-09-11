import fs from 'node:fs/promises';
import path from 'node:path';
import { captureScreenshot, launchBrowser } from './browser.js';
import type { Page } from 'puppeteer';
import type { TestCaseResult } from '@exercode/problem-utils';
import { buildTomcatUrl } from '@exercode/problem-utils/presets/tomcat';

export async function captureTomcatScreenshots(pages: readonly [Page, ...Page[]]): Promise<void> {
  const outputFiles: NonNullable<TestCaseResult['outputFiles']> = [];
  for (const [index, page] of pages.slice(0, 2).entries()) {
    try {
      outputFiles.push(
        await captureScreenshot(page, index === 0 ? 'screenshot_received.png' : 'screenshot_expected.png')
      );
    } catch {
      // Screenshot capture must not replace the verdict from the exercise checks.
    }
  }
  const directory = process.env.WORKING_DIRECTORY_PATH;
  if (directory) await fs.writeFile(path.join(directory, '__SCREENSHOTS.json'), JSON.stringify(outputFiles));
}

export async function verifyTomcatHtml(endpoint: string, expectedHtml: string): Promise<void> {
  const browser = await launchBrowser();
  try {
    const context = await browser.createBrowserContext();
    const actualPage = await context.newPage();
    const expectedPage = await context.newPage();
    await Promise.all([
      actualPage.setViewport({ width: 800, height: 600 }),
      expectedPage.setViewport({ width: 800, height: 600 }),
    ]);
    try {
      await actualPage.goto(buildTomcatUrl(endpoint), { waitUntil: 'networkidle0' });
      await expectedPage.setContent(expectedHtml);
      const actual = await actualPage.evaluate(() => document.documentElement.outerHTML);
      const expected = await expectedPage.evaluate(() => document.documentElement.outerHTML);
      if (actual.replaceAll(/\s+/g, '') !== expected.replaceAll(/\s+/g, ''))
        throw new Error('HTMLの構造が一致しません');
      await captureTomcatScreenshots([actualPage]);
    } catch (error) {
      await captureTomcatScreenshots([actualPage, expectedPage]);
      throw error;
    }
  } finally {
    await browser.close();
  }
}

/** Waits for a course endpoint and reports the expected and actual paths on failure. */
export async function verifyTomcatPath(page: Page, endpoint: string): Promise<void> {
  const expectedPath = new URL(buildTomcatUrl(endpoint)).pathname;
  try {
    await page.waitForFunction(
      (pathname) => location.pathname === pathname && document.readyState !== 'loading',
      { timeout: 5000 },
      expectedPath
    );
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
    const currentPath = new URL(page.url()).pathname;
    if (currentPath === expectedPath)
      throw new Error(`ページの読み込み（DOM解析）が5秒以内に完了しませんでした。現在のURL: ${currentPath}`);
    throw new Error(`URL遷移に失敗しました。期待されるURL: ${expectedPath}、現在のURL: ${currentPath}`);
  }
}
