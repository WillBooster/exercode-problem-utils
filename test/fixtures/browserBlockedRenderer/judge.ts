import { DecisionCode } from '@exercode/problem-utils';
import { browserJudgePreset } from '@exercode/problem-utils-browser';

await browserJudgePreset({
  screenshotOnFailure: true,
  testCases: [
    [
      'blocked_renderer',
      async (page) => {
        page.setDefaultTimeout(200);
        await page.evaluate(() => {
          setTimeout(() => {
            const end = performance.now() + 3000;
            while (performance.now() < end) {
              // A submitted script can occupy the renderer beyond the capture deadline.
            }
          }, 0);
        });
        try {
          await page.waitForSelector('#missing-submission-element');
        } catch {
          return { decisionCode: DecisionCode.WRONG_ANSWER, feedbackMarkdown: 'The required element is missing.' };
        }
        return { decisionCode: DecisionCode.ACCEPTED };
      },
    ],
  ],
});
