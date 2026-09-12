import path from 'node:path';
import { DecisionCode } from '@exercode/problem-utils';
import { browserJudgePreset } from '@exercode/problem-utils-browser';

await browserJudgePreset({
  directoryPath: path.join(import.meta.dirname, 'site'),
  initializePage(page) {
    if (process.argv[4] === 'custom') {
      page.on('dialog', (dialog) => void dialog.accept('learner input'));
    }
  },
  testCases: [
    ['dialogs', async (page) => {
      const result = await page.evaluate(() => ({ confirmed: confirm('continue?'), value: prompt('value?') }));
      return { decisionCode: DecisionCode.ACCEPTED, stdout: JSON.stringify(result) };
    }],
  ],
});
