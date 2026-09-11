import path from 'node:path';
import { DecisionCode, printTestCaseResult } from '@exercode/problem-utils';
import { browserJudgePreset } from '@exercode/problem-utils-browser';

const messages: string[] = [];
await browserJudgePreset({
  directoryPath: path.join(import.meta.dirname, 'site'),
  entryPath: '/nested/page.html',
  navigationOptions: { waitUntil: 'load' },
  initializePage: (page) => {
    page.on('console', (message) => messages.push(message.text()));
  },
  testCases: [
    ['page', async (page) => {
      const heading = await page.locator('h1').innerText();
      await page.locator('h1').evaluate((element) => { element.textContent = 'Checked'; });
      return { decisionCode: DecisionCode.ACCEPTED, stdout: heading };
    }],
  ],
  afterTests: async (page) => {
    printTestCaseResult({
      testCaseId: 'after',
      decisionCode: DecisionCode.ACCEPTED,
      stdout: [...messages, await page.locator('h1').innerText()].join('\n'),
    });
  },
});
