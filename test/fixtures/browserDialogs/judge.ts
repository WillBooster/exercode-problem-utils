import path from 'node:path';
import { DecisionCode } from '@exercode/problem-utils';
import { browserJudgePreset, type Dialog } from '@exercode/problem-utils-browser';

let handledDialogs = 0;
await browserJudgePreset({
  directoryPath: path.join(import.meta.dirname, 'site'),
  initializePage(page) {
    const handler = async (dialog: Dialog): Promise<void> => {
      await Promise.resolve();
      await dialog.accept('learner input');
      handledDialogs++;
    };
    if (process.argv[4] === 'custom') page.on('dialog', handler);
    if (process.argv[4] === 'once') page.once('dialog', handler);
  },
  testCases: [
    ['dialogs', async (page) => {
      const result = await page.evaluate(() => ({ confirmed: confirm('continue?'), value: prompt('value?') }));
      return { decisionCode: DecisionCode.ACCEPTED, stdout: JSON.stringify({ ...result, handledDialogs }) };
    }],
  ],
});
