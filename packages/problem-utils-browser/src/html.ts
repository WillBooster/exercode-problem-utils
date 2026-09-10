import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

import {
  DecisionCode,
  parseArgs,
  printTestCaseResult,
  startHttpServer,
  type TestCaseResult,
} from '@exercode/problem-utils';
import type { Page, Route } from 'playwright-core';
import { format } from 'prettier';
import prettierPluginOrganizeAttributes from 'prettier-plugin-organize-attributes';

import { launchBrowser } from './browser.js';
import { createTemporaryDirectory } from './temporaryDirectory.js';

type JudgeCaseResult = Omit<TestCaseResult, 'testCaseId'>;
interface JudgeContext {
  solutionUrl: string;
  submissionUrl: string;
}

export interface HtmlJudgePresetOptions {
  solutionDirectoryPath: string;
  requiredFiles?: readonly string[];
}

/** Compares a submitted HTML page with its model answer's DOM and rendered screenshot. */
export async function htmlJudgePreset(options: HtmlJudgePresetOptions): Promise<void> {
  const args = parseArgs(process.argv);
  const submissionDirectoryPath = args.cwd;
  if (!submissionDirectoryPath) throw new Error('cwd argument required');
  const missingFiles =
    options.requiredFiles?.filter((file) => !fs.existsSync(path.join(submissionDirectoryPath, file))) ?? [];
  if (missingFiles.length > 0) {
    printTestCaseResult({
      testCaseId: 'required_submission_files',
      decisionCode: DecisionCode.MISSING_REQUIRED_SUBMISSION_FILE_ERROR,
      feedbackMarkdown: `必要なファイルが提出されていません (There are required but missing files):\n${missingFiles.map((file) => `- \`${file}\``).join('\n')}`,
    });
    return;
  }
  await using submissionDirectory = await createHtmlServedDirectory(submissionDirectoryPath);
  await using submissionServer = startHttpServer(submissionDirectory.path);
  await using solutionDirectory = await createHtmlServedDirectory(options.solutionDirectoryPath);
  await using solutionServer = startHttpServer(solutionDirectory.path);
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    context.setDefaultTimeout(30_000);
    const ctx: JudgeContext = { solutionUrl: solutionServer.url, submissionUrl: submissionServer.url };
    const checks = [
      ['snapshot_body', testSnapshotBody],
      ['screenshot', testScreenshot],
    ] as const;
    for (const [testCaseId, check] of checks) {
      const actualPage = await context.newPage();
      const solutionPage = await context.newPage();
      try {
        const result = await check(actualPage, solutionPage, ctx);
        printTestCaseResult({ testCaseId, ...result });
        if (result.decisionCode !== DecisionCode.ACCEPTED) break;
      } finally {
        await Promise.all([actualPage.close(), solutionPage.close()]);
      }
    }
  } finally {
    await browser.close();
  }
}

async function testSnapshotBody(page: Page, solutionPage: Page, ctx: JudgeContext): Promise<JudgeCaseResult> {
  try {
    const [expected, actual] = await Promise.all([
      captureHtmlBodySnapshot(solutionPage, ctx.solutionUrl),
      captureHtmlBodySnapshot(page, ctx.submissionUrl),
    ]);
    if (expected !== actual) {
      return {
        decisionCode: DecisionCode.WRONG_ANSWER,
        feedbackMarkdown: 'HTMLの構造が模範解答と一致しません。',
      };
    }
    return { decisionCode: DecisionCode.ACCEPTED };
  } catch (error) {
    return {
      decisionCode: DecisionCode.JUDGE_NOT_AVAILABLE,
      stderr: error instanceof Error ? error.message : String(error),
      feedbackMarkdown: 'HTML構造の比較中にエラーが発生しました。',
    };
  }
}

async function testScreenshot(page: Page, solutionPage: Page, ctx: JudgeContext): Promise<JudgeCaseResult> {
  try {
    let [expectedHtml, actualHtml] = await Promise.all([
      loadFormattedHtmlForScreenshot(ctx.solutionUrl),
      loadFormattedHtmlForScreenshot(ctx.submissionUrl),
    ]);
    if (expectedHtml === undefined || actualHtml === undefined) {
      expectedHtml = undefined;
      actualHtml = undefined;
    }
    const [expectedScreenshot, actualScreenshot] = await Promise.all([
      capturePreparedHtmlScreenshot(solutionPage, ctx.solutionUrl, expectedHtml),
      capturePreparedHtmlScreenshot(page, ctx.submissionUrl, actualHtml),
    ]);
    if (!expectedScreenshot.equals(actualScreenshot)) {
      return {
        decisionCode: DecisionCode.WRONG_ANSWER,
        feedbackMarkdown: 'スクリーンショットが模範解答と一致しません。',
        outputFiles: [
          { path: 'screenshot_expected.png', data: expectedScreenshot.toString('base64'), encoding: 'base64' },
          { path: 'screenshot_received.png', data: actualScreenshot.toString('base64'), encoding: 'base64' },
        ],
      };
    }
    return { decisionCode: DecisionCode.ACCEPTED };
  } catch (error) {
    return {
      decisionCode: DecisionCode.JUDGE_NOT_AVAILABLE,
      stderr: error instanceof Error ? error.message : String(error),
      feedbackMarkdown: 'スクリーンショット比較中にエラーが発生しました。',
    };
  }
}

export async function captureHtmlBodySnapshot(page: Page, url: string): Promise<string> {
  await page.goto(url);
  return page.evaluate(() => {
    function snapshotNodes(nodes: readonly ChildNode[]): unknown[] {
      return nodes
        .map(snapshotNode)
        .filter((node): node is Exclude<ReturnType<typeof snapshotNode>, undefined> => node !== undefined);
    }

    function snapshotNode(
      node: ChildNode
    ):
      | { type: 'text'; text: string }
      | { attrs: [string, string][]; children: unknown[]; tag: string; type: 'element' }
      | undefined {
      if (node.nodeType === Node.COMMENT_NODE) return undefined;

      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.replaceAll(/\s+/g, ' ').trim() ?? '';
        if (!text) return undefined;
        return { type: 'text', text };
      }

      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        const attrs = [...element.attributes]
          .map((attr) => [attr.name, attr.value] as [string, string])
          .toSorted(([a], [b]) => a.localeCompare(b));
        return {
          type: 'element',
          tag: element.tagName.toLowerCase(),
          attrs,
          children: snapshotNodes([...element.childNodes]),
        };
      }

      return undefined;
    }

    return JSON.stringify(snapshotNodes([...document.body.childNodes]));
  });
}

export async function captureHtmlScreenshot(page: Page, url: string): Promise<Buffer> {
  return capturePreparedHtmlScreenshot(page, url, await loadFormattedHtmlForScreenshot(url));
}

async function capturePreparedHtmlScreenshot(page: Page, url: string, formattedHtml?: string): Promise<Buffer> {
  if (formattedHtml === undefined) {
    await page.goto(url, { waitUntil: 'load' });
  } else {
    // Keep the document URL so relative base elements and asset URLs resolve as served.
    // Interception stays active until subresources finish loading.
    const renderHtml = async (route: Route) => route.fulfill({ contentType: 'text/html', body: formattedHtml });
    await page.route(url, renderHtml);
    try {
      await page.goto(url, { waitUntil: 'load' });
    } finally {
      await page.unroute(url, renderHtml);
    }
  }

  await page.evaluate(async () => {
    const style = document.createElement('style');
    style.textContent = `
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
        caret-color: transparent !important;
      }
    `;
    document.head.append(style);
    if ('fonts' in document) await document.fonts.ready;
  });
  const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
  return Buffer.from(screenshot);
}

async function loadFormattedHtmlForScreenshot(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url);
    if (!response.ok) return undefined;

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) return undefined;

    const html = await response.text();
    const formattedHtml = await format(html, {
      parser: 'html',
      htmlWhitespaceSensitivity: 'ignore',
      plugins: [prettierPluginOrganizeAttributes],
      attributeGroups: [],
      attributeIgnoreCase: false,
      attributeSort: 'ASC',
    });
    return formattedHtml;
  } catch {
    return undefined;
  }
}

export interface ServedDirectory {
  [Symbol.asyncDispose]: () => Promise<void>;
  path: string;
}

export async function createHtmlServedDirectory(sourceDirectoryPath: string): Promise<ServedDirectory> {
  sourceDirectoryPath = path.resolve(sourceDirectoryPath);
  const directory = createTemporaryDirectory('judge-html-');
  const servedDirectoryPath = directory.path;
  try {
    await mergeDirectory(sourceDirectoryPath, servedDirectoryPath);

    const ownAssets = path.join(sourceDirectoryPath, 'assets');
    if (fs.statSync(ownAssets, { throwIfNoEntry: false })?.isDirectory()) {
      await mergeDirectory(ownAssets, servedDirectoryPath);
    }
    const sharedAssets = findNearestAssetDirectory(path.dirname(sourceDirectoryPath));
    if (sharedAssets) {
      await mergeDirectory(sharedAssets, path.join(servedDirectoryPath, 'assets'));
      await mergeDirectory(sharedAssets, servedDirectoryPath);
    }
  } catch (error) {
    await directory[Symbol.asyncDispose]();
    throw error;
  }

  return directory;
}

async function mergeDirectory(sourceDirectoryPath: string, destinationDirectoryPath: string): Promise<void> {
  const destination = fs.lstatSync(destinationDirectoryPath, { throwIfNoEntry: false });
  // Existing files and links are complete overrides; only temporary directories receive merged entries.
  if (destination && !destination.isDirectory()) return;
  await fsPromises.mkdir(destinationDirectoryPath, { recursive: true });
  for (const entry of await fsPromises.readdir(sourceDirectoryPath, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDirectoryPath, entry.name);
    const destinationPath = path.join(destinationDirectoryPath, entry.name);
    if (entry.isDirectory()) {
      await mergeDirectory(sourcePath, destinationPath);
    } else if (!fs.lstatSync(destinationPath, { throwIfNoEntry: false })) {
      await fsPromises.symlink(sourcePath, destinationPath);
    }
  }
}

function findNearestAssetDirectory(startDirectoryPath: string): string | undefined {
  let currentPath = startDirectoryPath;
  while (true) {
    const assets = path.join(currentPath, 'assets');
    if (fs.statSync(assets, { throwIfNoEntry: false })?.isDirectory()) return assets;
    const parent = path.dirname(currentPath);
    if (parent === currentPath) return undefined;
    currentPath = parent;
  }
}
