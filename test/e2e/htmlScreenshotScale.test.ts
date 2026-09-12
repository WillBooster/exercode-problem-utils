import assert from 'node:assert/strict';
import http from 'node:http';
import { expect, test } from 'vitest';
import { captureHtmlScreenshotPair, launchBrowser } from '@exercode/problem-utils-browser';

test(
  'HTML screenshots retain the configured scale when page code changes devicePixelRatio',
  { timeout: 30_000 },
  async () => {
    await using server = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        `<!doctype html><html><body style="margin:0;height:1500px;background:linear-gradient(red,blue)"><h1 style="margin:0">日本語</h1>${
          request.url === '/actual'
            ? '<script>Object.defineProperty(window, "devicePixelRatio", { value: 3 });</script>'
            : ''
        }</body></html>`
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    const browser = await launchBrowser({
      defaultViewport: { width: 803, height: 601, deviceScaleFactor: 1.5 },
      args: ['--force-device-scale-factor=1.25'],
    });
    try {
      const expected = await browser.newPage();
      const actual = await browser.newPage();
      const screenshots = await captureHtmlScreenshotPair(
        { page: expected, url: `${url}/expected` },
        { page: actual, url: `${url}/actual` }
      );
      expect(screenshots[0].equals(screenshots[1])).toBe(true);
      expect(screenshots[0].readUInt32BE(16)).toBe(1205);
      expect(screenshots[0].readUInt32BE(20)).toBe(2250);
      expect(await actual.evaluate('window.devicePixelRatio')).toBe(3);
    } finally {
      await browser.close();
    }
  }
);
