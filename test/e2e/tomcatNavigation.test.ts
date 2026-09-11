import http from 'node:http';
import { once } from 'node:events';
import { expect, test } from 'vitest';
import { buildTomcatUrl } from '@exercode/problem-utils/presets/tomcat';
import { launchBrowser, verifyTomcatPath } from '@exercode/problem-utils-browser';

test('course navigation accepts the endpoint path and reports a wrong destination', { timeout: 30_000 }, async () => {
  await using server = http.createServer((request, response) => {
    if (request.url?.includes('result.jsp')) {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.write('<html><body>');
      setTimeout(() => response.end('<h1>Course page</h1></body></html>'), 150);
    } else {
      response.end('<h1>Course page</h1>');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const expectedPath = new URL(buildTomcatUrl('/result.jsp')).pathname;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await page.goto(`${baseUrl}/initial`);
    const navigation = page.goto(`${baseUrl}${expectedPath}?answer=42`, { waitUntil: 'commit' });
    await verifyTomcatPath(page, '/result.jsp');
    expect(await page.evaluate('document.querySelector("h1")?.textContent')).toBe('Course page');
    await navigation;
    await page.goto(`${baseUrl}/wrong`);
    await expect(verifyTomcatPath(page, '/result.jsp')).rejects.toThrow(
      `URL遷移に失敗しました。期待されるURL: ${expectedPath}、現在のURL: /wrong`
    );
  } finally {
    await browser.close();
  }
});
