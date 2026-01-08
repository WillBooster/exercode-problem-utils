import { DecisionCode, parseArgs, printTestCaseResult, startHttpServer } from '@exercode/problem-utils';
import type { TestCaseResult } from '@exercode/problem-utils';
import assert from 'node:assert';
import puppeteer from 'puppeteer';
import type { Page } from 'puppeteer';

const TEST_CASES: readonly [string, (page: Page) => Promise<Omit<TestCaseResult, 'testCaseId'>>][] = [
  [
    '01_h1',
    async (page) => {
      try {
        const h1Handle = await page.locator('h1').waitHandle();
        const h1Text = await h1Handle.evaluate((e) => e.textContent.trim());
        assert.strictEqual(h1Text, '今日の天気予報');
      } catch (error) {
        return {
          decisionCode: DecisionCode.WRONG_ANSWER,
          stderr: error instanceof Error ? error.message : String(error),
          feedbackMarkdown: '`h1`タグによる見出し`今日の天気予報`が見つかりません。',
        };
      }
      return { decisionCode: DecisionCode.ACCEPTED };
    },
  ],
  [
    '02_hr',
    async (page) => {
      try {
        await page.locator('hr').waitHandle();
      } catch (error) {
        return {
          decisionCode: DecisionCode.WRONG_ANSWER,
          stderr: error instanceof Error ? error.message : String(error),
          feedbackMarkdown: '`hr`タグによる水平線が見つかりません。',
        };
      }
      return { decisionCode: DecisionCode.ACCEPTED };
    },
  ],
  [
    '03_p',
    async (page) => {
      const requiredTexts = ['晴れ', '最高気温：25℃', '最低気温：18℃', '降水確率：0%'];

      const pTexts = await page.$$eval('p', (es) => es.map((e) => e.textContent?.trim() ?? ''));

      if (pTexts.length !== requiredTexts.length) {
        return {
          decisionCode: DecisionCode.WRONG_ANSWER,
          feedbackMarkdown: `\`p\`タグの件数が一致しません。\n${requiredTexts.length}件必要ですが、${pTexts.length}件見つかりました。`,
        };
      }

      for (const [i, expected] of requiredTexts.entries()) {
        if (pTexts[i] === expected) continue;
        return {
          decisionCode: DecisionCode.WRONG_ANSWER,
          feedbackMarkdown: `\`p\`タグの内容が一致しません。\n${i + 1}番目には\`${expected}\`が期待されていますが、\`${pTexts[i]}\`が見つかりました。`,
        };
      }

      return { decisionCode: DecisionCode.ACCEPTED };
    },
  ],
];

const args = parseArgs(process.argv);
await using server = startHttpServer(args.cwd);

const browser = await puppeteer.launch();
const page = await browser.newPage();
page.setDefaultTimeout(1000);

await page.goto(server.url, { waitUntil: 'domcontentloaded' });

for (const [testCaseId, test] of TEST_CASES) {
  const result = await test(page);
  printTestCaseResult({ testCaseId, ...result });
  if (result.decisionCode !== DecisionCode.ACCEPTED) break;
}

await browser.close();
