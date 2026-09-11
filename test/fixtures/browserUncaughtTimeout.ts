import { DecisionCode } from '@exercode/problem-utils';
import { browserJudgePreset } from '@exercode/problem-utils-browser';

await browserJudgePreset({
  timeoutMs: 100,
  testCases: [
    [
      'missing',
      async (page) => {
        await page.waitForSelector('#missing-submission-element');
        return { decisionCode: DecisionCode.ACCEPTED };
      },
    ],
  ],
});
