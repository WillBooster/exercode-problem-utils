import assert from 'node:assert/strict';
import http from 'node:http';
import { expect, test } from 'vitest';
import { captureHtmlScreenshotPair, launchBrowser } from '@exercode/problem-utils-browser';

test('HTML screenshots preserve caller-owned asset interception', { timeout: 30_000 }, async () => {
  await using server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      '<!doctype html><html><head><link rel="stylesheet" href="/mock.css"></head><body><h1>Course</h1></body></html>'
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const browser = await launchBrowser();
  try {
    const pages = await Promise.all([browser.newPage(), browser.newPage()]);
    for (const page of pages) {
      await page.setRequestInterception(true);
      page.on('request', async (request) => {
        await (request.url().endsWith('/mock.css')
          ? request.respond({ contentType: 'text/css', body: 'body { background: rgb(255, 0, 0); }' })
          : request.continue());
      });
    }
    const [expected, actual] = await captureHtmlScreenshotPair({ page: pages[0]!, url }, { page: pages[1]!, url });
    expect(expected.equals(actual)).toBe(true);
    for (const page of pages) {
      expect(await page.evaluate('getComputedStyle(document.body).backgroundColor')).toBe('rgb(255, 0, 0)');
      expect(await page.evaluate(() => fetch('/mock.css').then((response) => response.text()))).toBe(
        'body { background: rgb(255, 0, 0); }'
      );
    }
  } finally {
    await browser.close();
  }
});
