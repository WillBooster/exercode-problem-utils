import { DecisionCode } from '@exercode/problem-utils';
import { browserJudgePreset } from '@exercode/problem-utils-browser';

await browserJudgePreset({
  screenshotOnFailure: true,
  testCases: [
    [
      'closed_page',
      async (page) => {
        await page.close();
        return Object.freeze({ decisionCode: DecisionCode.WRONG_ANSWER, feedbackMarkdown: 'The answer is incorrect.' });
      },
    ],
  ],
});
