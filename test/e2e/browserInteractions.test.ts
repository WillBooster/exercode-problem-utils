import { createServer } from 'node:http';
import { expect, test } from 'vitest';
import {
  clickAndDetectCanceledSubmit,
  evaluateBrowserProgram,
  launchBrowser,
  requirePageElement,
  submitFormAndCaptureRequest,
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
      await expect(clickAndDetectCanceledSubmit(page, '#answer')).rejects.toThrow('要素が見つかりません: #answer');
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

for (const target of ['form', 'document', 'window', 'stopped-form', 'capturing-document'] as const) {
  test(`form cancellation is observed for ${target} handlers`, { timeout: 30_000 }, async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setContent('<form><input required><button id="add">Add</button></form><output></output>');
      await page.evaluate(`
        const target = ${JSON.stringify(target)};
        const form = document.querySelector('form');
        const listenerTarget = target === 'document' || target === 'capturing-document' ? document : target === 'window' ? globalThis : form;
        listenerTarget.addEventListener('submit', (event) => {
          document.querySelector('output').textContent += 'added';
          event.preventDefault();
          if (target === 'stopped-form' || target === 'capturing-document') event.stopPropagation();
        }, target === 'capturing-document');
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

for (const method of ['GET', 'POST']) {
  test(`form capture reads ${method} Japanese fields without reaching the server`, { timeout: 30_000 }, async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? '');
      response.end('reachable');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const url = `http://127.0.0.1:${address.port}`;
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<form action="${url}/submit" method="${method}"><input name="query" value="日本語 + space"><button>Send</button></form>`
      );
      const [, captured] = await Promise.all([
        page.waitForNavigation({ waitUntil: 'load' }),
        submitFormAndCaptureRequest(page, 'button'),
      ]);
      expect(captured?.method).toBe(method);
      expect(captured?.path).toBe('/submit');
      expect(captured?.params.get('query')).toBe('日本語 + space');
      expect(requests).not.toContainEqual(expect.stringContaining('/submit'));
      await page.goto(`${url}/after`);
      expect(await page.$eval('body', (element) => element.textContent)).toBe('reachable');
      expect(requests).toContain('/after');
      await page.setContent('<button type="button">No submission</button>');
      expect(await submitFormAndCaptureRequest(page, 'button', 100)).toBeUndefined();
      await expect(submitFormAndCaptureRequest(page, '#missing', 100)).rejects.toThrow();
      await page.goto(`${url}/after-error`);
      expect(requests).toContain('/after-error');
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
}
