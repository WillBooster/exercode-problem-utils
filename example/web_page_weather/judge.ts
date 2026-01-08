import { DecisionCode, parseArgs, printTestCaseResult, startHttpServer } from '@exercode/problem-utils';
import type { TestCaseResult } from '@exercode/problem-utils';
import puppeteer from 'puppeteer';
import type { Page } from 'puppeteer';

const TEST_CASES: readonly [string, (page: Page) => Promise<Omit<TestCaseResult, 'testCaseId'>>][] = [
  [
    '01',
    async (page) => {
      // WIP
      return { decisionCode: DecisionCode.ACCEPTED, feedbackMarkdown: '' };
    },
  ],
];

const args = parseArgs(process.argv);
await using server = startHttpServer(args.cwd);

const browser = await puppeteer.launch();
const page = await browser.newPage();

await page.goto(server.url);

for (const [testCaseId, test] of TEST_CASES) {
  const result = await test(page);
  printTestCaseResult({ testCaseId, ...result });
}

await browser.close();
