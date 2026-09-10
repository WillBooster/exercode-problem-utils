import { DecisionCode } from '@exercode/problem-utils';
import type { TestCaseResult } from '@exercode/problem-utils';
import assert from 'node:assert';
import { browserJudgePreset, type Page } from '@exercode/problem-utils-browser';

const TEST_CASES: readonly [string, (page: Page) => Promise<Omit<TestCaseResult, 'testCaseId'>>][] = [
  [
    '01_h1',
    async (page) => {
      try {
        const heading = await page.locator('h1').first().textContent();
        const h1Text = heading?.trim() ?? '';
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
        await page.locator('hr').first().waitFor({ state: 'attached' });
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

await browserJudgePreset({ testCases: TEST_CASES, timeoutMs: 1000 });
