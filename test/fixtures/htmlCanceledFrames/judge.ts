import assert from 'node:assert/strict';
import http from 'node:http';
import { captureHtmlScreenshotPair, launchBrowser } from '@exercode/problem-utils-browser';

await using server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(request.url === '/frame' ? '<h1>Frame</h1>' : `<!doctype html><html><body><h1>Course</h1><script>
    for (let i = 0; i < 20; i++) {
      const frame = document.createElement('iframe');
      frame.src = '/frame';
      document.body.append(frame);
      setTimeout(() => frame.remove(), 1);
    }
  </script></body></html>`);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}/`;
const browser = await launchBrowser();
try {
  const expected = await browser.newPage();
  const actual = await browser.newPage();
  const screenshots = await captureHtmlScreenshotPair({ page: expected, url }, { page: actual, url });
  console.log(JSON.stringify(screenshots.map((screenshot) => screenshot.toString('base64'))));
} finally {
  await browser.close();
}
