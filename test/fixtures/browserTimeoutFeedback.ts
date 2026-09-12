import { DecisionCode } from '@exercode/problem-utils';
import { browserJudgePreset } from '@exercode/problem-utils-browser';

await browserJudgePreset({
  timeoutMs: 100,
  testCases: [
    [
      'missing',
      async (page) => {
        try {
          await page.waitForSelector('#missing-submission-element');
          return { decisionCode: DecisionCode.ACCEPTED };
        } catch (error) {
          return {
            decisionCode: DecisionCode.WRONG_ANSWER,
            stderr: error instanceof Error ? error.message : String(error),
          };
        }
      },
    ],
  ],
});
