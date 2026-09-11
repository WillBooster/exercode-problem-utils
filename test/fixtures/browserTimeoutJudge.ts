import { DecisionCode } from '@exercode/problem-utils';
import { browserJudgePreset } from '@exercode/problem-utils-browser';

try {
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
} catch (error) {
  process.stderr.write(error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}\n` : String(error));
  process.exitCode = 1;
}
