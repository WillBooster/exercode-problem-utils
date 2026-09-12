import { expect, test } from 'vitest';
import { evaluateBrowserProgram, launchBrowser, requirePageElement } from '@exercode/problem-utils-browser';

test(
  'required course controls fail when absent and support native input and click actions',
  { timeout: 30_000 },
  async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setContent('<main></main>');
      await expect(requirePageElement(page, '#answer')).rejects.toThrow('要素が見つかりません: #answer');
      await page.setContent(
        '<input id="answer"><button onclick="document.body.dataset.answer = document.querySelector(\'#answer\').value">Submit</button>'
      );
      const input = await requirePageElement(page, '#answer');
      await input.type('42');
      const button = await requirePageElement(page, 'button');
      await button.click();
      expect(await page.$eval('body', (element) => element.dataset.answer)).toBe('42');
    } finally {
      await browser.close();
    }
  }
);

test('closing a page preserves the evaluator target-close error', { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const started = new Promise<void>((resolve) => page.once('console', () => resolve()));
    const evaluation = evaluateBrowserProgram(page, 'console.log("started"); new Promise(() => {});');
    const rejected = expect(evaluation).rejects.toMatchObject({ name: 'TargetCloseError' });
    await started;
    await Promise.all([rejected, page.close()]);
  } finally {
    await browser.close();
  }
});
