import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DecisionCode,
  parseArgs,
  printTestCaseResult,
  startHttpServer,
  type TestCaseResult,
} from '@exercode/problem-utils';
import type { BrowserContext, Page } from 'playwright-core';
import { format } from 'prettier';
import prettierPluginOrganizeAttributes from 'prettier-plugin-organize-attributes';

import { launchBrowser } from './browser.js';

type JudgeCaseResult = Omit<TestCaseResult, 'testCaseId'>;
interface JudgeContext {
  context: BrowserContext;
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
    const page = await context.newPage();
    const ctx: JudgeContext = { context, solutionUrl: solutionServer.url, submissionUrl: submissionServer.url };
    const checks = [
      ['snapshot_body', testSnapshotBody],
      ['screenshot', testScreenshot],
    ] as const;
    for (const [testCaseId, check] of checks) {
      const result = await check(page, ctx);
      printTestCaseResult({ testCaseId, ...result });
      if (result.decisionCode !== DecisionCode.ACCEPTED) break;
    }
  } finally {
    await browser.close();
  }
}

async function testSnapshotBody(page: Page, ctx: JudgeContext): Promise<JudgeCaseResult> {
  let solutionPage: Page | undefined;

  try {
    solutionPage = await ctx.context.newPage();

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
  } catch (error) {
    return {
      decisionCode: DecisionCode.JUDGE_NOT_AVAILABLE,
      stderr: error instanceof Error ? error.message : String(error),
      feedbackMarkdown: 'HTML構造の比較中にエラーが発生しました。',
    };
  } finally {
    await solutionPage?.close();
  }

  return { decisionCode: DecisionCode.ACCEPTED };
}

async function testScreenshot(page: Page, ctx: JudgeContext): Promise<JudgeCaseResult> {
  let solutionPage: Page | undefined;

  try {
    solutionPage = await ctx.context.newPage();

    const [expectedScreenshot, actualScreenshot] = await Promise.all([
      captureHtmlScreenshot(solutionPage, ctx.solutionUrl),
      captureHtmlScreenshot(page, ctx.submissionUrl),
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
  } catch (error) {
    return {
      decisionCode: DecisionCode.JUDGE_NOT_AVAILABLE,
      stderr: error instanceof Error ? error.message : String(error),
      feedbackMarkdown: 'スクリーンショット比較中にエラーが発生しました。',
    };
  } finally {
    await solutionPage?.close();
  }

  return { decisionCode: DecisionCode.ACCEPTED };
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
  const formattedHtml = await loadFormattedHtmlForScreenshot(url);
  await (formattedHtml === undefined
    ? page.goto(url, { waitUntil: 'load' })
    : page.setContent(formattedHtml, { waitUntil: 'load' }));

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
    return injectBaseTag(formattedHtml, url);
  } catch {
    return undefined;
  }
}

function injectBaseTag(html: string, url: string): string {
  if (/<base\s/i.test(html)) return html;

  const baseTag = `<base href="${url}">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  }

  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`);
  }

  return `<head>${baseTag}</head>${html}`;
}

export interface ServedDirectory {
  [Symbol.asyncDispose]: () => Promise<void>;
  path: string;
}

export async function createHtmlServedDirectory(sourceDirectoryPath: string): Promise<ServedDirectory> {
  sourceDirectoryPath = path.resolve(sourceDirectoryPath);
  const servedDirectoryPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'judge-html-'));
  try {
    await mergeDirectory(sourceDirectoryPath, servedDirectoryPath);

    const assetDirectoryPath = findNearestAssetDirectory(sourceDirectoryPath);
    if (assetDirectoryPath) {
      const servedAssetsDirectoryPath = path.join(servedDirectoryPath, 'assets');
      if (!fs.existsSync(servedAssetsDirectoryPath)) {
        await fsPromises.symlink(assetDirectoryPath, servedAssetsDirectoryPath);
      }
      await mergeDirectory(assetDirectoryPath, servedDirectoryPath);
    }
  } catch (error) {
    await fsPromises.rm(servedDirectoryPath, { recursive: true, force: true });
    throw error;
  }

  return {
    path: servedDirectoryPath,
    async [Symbol.asyncDispose]() {
      await fsPromises.rm(servedDirectoryPath, { force: true, recursive: true });
    },
  };
}

async function mergeDirectory(sourceDirectoryPath: string, destinationDirectoryPath: string): Promise<void> {
  await fsPromises.mkdir(destinationDirectoryPath, { recursive: true });

  const dirents = await fsPromises.readdir(sourceDirectoryPath, { withFileTypes: true });
  for (const dirent of dirents) {
    const sourcePath = path.join(sourceDirectoryPath, dirent.name);
    const destinationPath = path.join(destinationDirectoryPath, dirent.name);

    if (dirent.isDirectory()) {
      await mergeDirectory(sourcePath, destinationPath);
      continue;
    }

    if (dirent.isSymbolicLink()) {
      if (fs.existsSync(destinationPath)) {
        const sourceStat = await fsPromises.stat(sourcePath);
        if (sourceStat.isDirectory()) {
          await mergeDirectory(sourcePath, destinationPath);
        }
        continue;
      }

      const linkedPath = await fsPromises.readlink(sourcePath);
      await fsPromises.symlink(path.resolve(path.dirname(sourcePath), linkedPath), destinationPath);
      continue;
    }

    if (!fs.existsSync(destinationPath)) {
      await fsPromises.symlink(sourcePath, destinationPath);
    }
  }
}

function findNearestAssetDirectory(problemDirectoryPath: string): string | undefined {
  let currentPath = problemDirectoryPath;
  while (currentPath !== path.dirname(currentPath)) {
    const assetDirectoryPath = path.join(currentPath, 'assets');
    if (fs.existsSync(assetDirectoryPath)) {
      return assetDirectoryPath;
    }
    currentPath = path.dirname(currentPath);
  }

  return undefined;
}
