import { createServer } from 'node:http';
import { expect, test } from 'vitest';
import {
  clickAndDetectCanceledSubmit,
  createBrowserPage,
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
    await page.setContent('<form action="javascript:void(0)"><button id="add">Add</button></form>');
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
    await using browser = await launchBrowser();
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? '');
      response.end('reachable');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const url = `http://127.0.0.1:${address.port}`;
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
      await page.goto(`${url}/after-timeout`);
      expect(requests).toContain('/after-timeout');
      await expect(submitFormAndCaptureRequest(page, '#missing', 100)).rejects.toThrow();
      await page.goto(`${url}/after-error`);
      expect(requests).toContain('/after-error');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
}

test(
  'submit cancellation survives an earlier window capture listener stopping immediate propagation',
  { timeout: 30_000 },
  async () => {
    await using browser = await launchBrowser();
    const page = await createBrowserPage(browser);
    const html = `<form><button id="add">Add</button></form><output></output><script>
    var Symbol = 1;
    const Reflect = {};
    window.addEventListener('submit', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      document.querySelector('output').textContent = 'added';
    }, { capture: true, once: true });
  </script>`;
    await page.goto(`data:text/html,${encodeURIComponent(html)}`);
    expect(await clickAndDetectCanceledSubmit(page, '#add')).toBe(true);
    expect(await page.$eval('output', (element) => element.textContent)).toBe('added');
    expect(await clickAndDetectCanceledSubmit(page, '#add')).toBe(false);
  }
);

test(
  'a non-submit control does not inherit a canceled submission from page initialization',
  { timeout: 30_000 },
  async () => {
    await using browser = await launchBrowser();
    const page = await createBrowserPage(browser);
    const html = `<form><button id="add" type="button">Add</button></form><output></output><script>
    window.addEventListener('submit', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      document.querySelector('output').textContent += 'submitted';
    }, { capture: true });
    document.querySelector('form').requestSubmit();
  </script>`;
    await page.goto(`data:text/html,${encodeURIComponent(html)}`);
    expect(await page.$eval('output', (element) => element.textContent)).toBe('submitted');
    expect(await clickAndDetectCanceledSubmit(page, '#add')).toBe(false);
    expect(await page.$eval('output', (element) => element.textContent)).toBe('submitted');
  }
);

test('form grading activates only controls reachable by a native pointer click', { timeout: 30_000 }, async () => {
  await using browser = await launchBrowser();
  const page = await createBrowserPage(browser);
  await page.goto(
    `data:text/html,${encodeURIComponent(`<form><button id="add" hidden>Add</button></form><output></output>
    <script>
      document.querySelector('button').addEventListener('click', (event) => {
        document.querySelector('output').textContent += event.isTrusted ? 'clicked' : 'synthetic';
      });
      document.querySelector('form').addEventListener('submit', (event) => event.preventDefault());
    </script>`)}`
  );
  expect(await clickAndDetectCanceledSubmit(page, '#add')).toBe(false);
  expect(await page.$eval('output', (element) => element.textContent)).toBe('');
  await page.$eval('button', (button) => {
    button.hidden = false;
    button.style.pointerEvents = 'none';
  });
  expect(await clickAndDetectCanceledSubmit(page, '#add')).toBe(false);
  expect(await page.$eval('output', (element) => element.textContent)).toBe('');
  await page.$eval('button', (button) => {
    button.style.removeProperty('pointer-events');
    button.style.position = 'absolute';
    button.style.left = '-9999px';
  });
  expect(await clickAndDetectCanceledSubmit(page, '#add')).toBe(false);
  expect(await page.$eval('output', (element) => element.textContent)).toBe('');
  await page.$eval('button', (button) => button.removeAttribute('style'));
  expect(await clickAndDetectCanceledSubmit(page, '#add')).toBe(true);
  expect(await page.$eval('output', (element) => element.textContent)).toBe('clicked');
  await page.$eval('button', (button) => button.ownerDocument.body.append(button));
  expect(await clickAndDetectCanceledSubmit(page, '#add')).toBe(false);
  expect(await page.$eval('output', (element) => element.textContent)).toBe('clicked');
});

test('concurrent form checks preserve independent cancellation results', { timeout: 30_000 }, async () => {
  await using browser = await launchBrowser();
  const page = await createBrowserPage(browser);
  await page.setContent(
    '<form action="javascript:void(0)"><button id="a">A</button><button id="b">B</button></form><output></output>'
  );
  await page.evaluate(`document.querySelector('form').addEventListener('submit', event => {
    document.querySelector('output').textContent += event.submitter.textContent;
    if (event.submitter.id === 'a') event.preventDefault();
  })`);
  expect(
    await Promise.all([clickAndDetectCanceledSubmit(page, '#a'), clickAndDetectCanceledSubmit(page, '#b')])
  ).toEqual([true, false]);
  expect(await page.$eval('output', (element) => element.textContent)).toBe('AB');
  await expect(clickAndDetectCanceledSubmit(page, '#missing')).rejects.toThrow('要素が見つかりません');
  expect(await clickAndDetectCanceledSubmit(page, '#a')).toBe(true);
  expect(await page.$eval('output', (element) => element.textContent)).toBe('ABA');
});

test(
  'uncanceled submissions return a normal verdict when navigation replaces the document',
  { timeout: 30_000 },
  async () => {
    await using browser = await launchBrowser({ slowMo: 5 });
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html');
      if (request.url?.startsWith('/done')) {
        response.end('<output>submitted</output>');
        return;
      }
      const handler =
        request.url === '/capture'
          ? `window.addEventListener('submit', event => event.stopImmediatePropagation(), true)`
          : `document.querySelector('form').addEventListener('submit', event => {
          event.stopPropagation();
          ${request.url === '/redirect' ? "location.replace('/done')" : ''}
        })`;
      response.end(`<form action="/done"><button id="add">Add</button></form><script>${handler}</script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    try {
      const page = await createBrowserPage(browser);
      for (const path of ['/form', '/capture', '/redirect']) {
        await page.goto(`http://127.0.0.1:${address.port}${path}`);
        const [canceled] = await Promise.all([
          clickAndDetectCanceledSubmit(page, '#add'),
          page.waitForNavigation({ waitUntil: 'load' }),
        ]);
        expect(canceled).toBe(false);
        expect(await page.$eval('output', (element) => element.textContent)).toBe('submitted');
      }
      await page.close();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }
);

test(
  'submit handlers installed during pointer activation determine the cancellation verdict',
  { timeout: 30_000 },
  async () => {
    await using browser = await launchBrowser();
    const page = await createBrowserPage(browser);
    await page.goto(
      `data:text/html,${encodeURIComponent(`<form><button>Add</button></form><output></output><script>
    document.querySelector('button').addEventListener('mousedown', () => {
      window.addEventListener('submit', event => {
        event.preventDefault();
        document.querySelector('output').textContent = 'canceled';
      });
    }, { once: true });
  </script>`)}`
    );
    expect(await clickAndDetectCanceledSubmit(page, 'button')).toBe(true);
    expect(await page.$eval('output', (element) => element.textContent)).toBe('canceled');
  }
);
