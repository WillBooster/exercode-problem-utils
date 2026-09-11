import { DecisionCode } from '@exercode/problem-utils';
import { browserJudgePreset } from '@exercode/problem-utils-browser';

await browserJudgePreset({
  timeoutMs: 100,
  testCases: [
    [
      'missing',
      async (page) => {
        await page.locator('#missing-submission-element').waitFor();
        return { decisionCode: DecisionCode.ACCEPTED };
      },
    ],
  ],
});
