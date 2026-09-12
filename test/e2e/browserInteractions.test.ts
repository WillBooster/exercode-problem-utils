import { expect, test } from 'vitest';
import {
  clickAndDetectCanceledSubmit,
  evaluateBrowserProgram,
  launchBrowser,
  requirePageElement,
} from '@exercode/problem-utils-browser';

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

for (const target of ['form', 'document', 'window', 'stopped-form'] as const) {
  test(`form cancellation is observed for ${target} handlers`, { timeout: 30_000 }, async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setContent('<form><input required><button id="add">Add</button></form><output></output>');
      await page.evaluate(`
        const target = ${JSON.stringify(target)};
        const form = document.querySelector('form');
        const listenerTarget = target === 'document' ? document : target === 'window' ? globalThis : form;
        listenerTarget.addEventListener('submit', (event) => {
          document.querySelector('output').textContent += 'added';
          event.preventDefault();
          if (target === 'stopped-form') event.stopPropagation();
        });
      `);
      expect(await clickAndDetectCanceledSubmit(page, '#add')).toBe(false);
      expect(await page.$eval('output', (element) => element.textContent)).toBe('');
      await page.type('input', 'Task');
      expect(await clickAndDetectCanceledSubmit(page, '#add')).toBe(true);
      expect(await page.$eval('output', (element) => element.textContent)).toBe('added');
      await page.evaluate("document.querySelector('button').setAttribute('type', 'button')");
      expect(await clickAndDetectCanceledSubmit(page, '#add')).toBe(false);
      expect(await page.$eval('output', (element) => element.textContent)).toBe('added');
    } finally {
      await browser.close();
    }
  });
}

test('form observers are removed between canceled and uncanceled submissions', { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<form><button id="add">Add</button></form>');
    await page.evaluate(
      "document.querySelector('form').addEventListener('submit', (event) => event.preventDefault(), { once: true })"
    );
    expect(await clickAndDetectCanceledSubmit(page, '#add')).toBe(true);
    expect(await clickAndDetectCanceledSubmit(page, '#add')).toBe(false);
    expect(await page.$('form')).not.toBeNull();
  } finally {
    await browser.close();
  }
});
