import { DecisionCode } from '@exercode/problem-utils';
import { browserJudgePreset } from '@exercode/problem-utils-browser';

await browserJudgePreset({
  testCases: [
    [
      'missing',
      async (page) => {
        await page.waitForSelector('#missing-submission-element', { timeout: 100 });
        return { decisionCode: DecisionCode.ACCEPTED };
      },
    ],
  ],
});
