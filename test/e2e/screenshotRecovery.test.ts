import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from 'vitest';
import { testCaseResultSchema } from '@exercode/problem-utils';
import { captureScreenshot, captureTomcatScreenshots, launchBrowser } from '@exercode/problem-utils-browser';

test(
  'a blocked submission screenshot leaves model diagnostics and later pages usable',
  { timeout: 20_000 },
  async () => {
    await fs.mkdir('.tmp', { recursive: true });
    const directory = await fs.mkdtemp(path.resolve('.tmp/screenshot-recovery-'));
    const previousDirectory = process.env.WORKING_DIRECTORY_PATH;
    process.env.WORKING_DIRECTORY_PATH = directory;
    const browser = await launchBrowser();
    try {
      const context = await browser.createBrowserContext();
      const actual = await context.newPage();
      const expected = await context.newPage();
      await expected.setViewport({ width: 800, height: 600, deviceScaleFactor: 2 });
      await expected.setContent('<body style="margin:0;height:1500px;background:red">Model answer</body>');
      actual.setDefaultTimeout(200);
      expected.setDefaultTimeout(2000);
      await actual.evaluate(() => {
        setTimeout(() => {
          const end = performance.now() + 10_000;
          while (performance.now() < end) {
            // A submitted program can occupy its renderer beyond the screenshot deadline.
          }
        }, 0);
      });
      await expect(actual.waitForSelector('#missing')).rejects.toThrow();
      await expect(captureScreenshot(actual)).rejects.toMatchObject({ name: 'TimeoutError' });
      await captureTomcatScreenshots([actual, expected]);
      const files = testCaseResultSchema.shape.outputFiles
        .unwrap()
        .parse(JSON.parse(await fs.readFile(path.join(directory, '__SCREENSHOTS.json'), 'utf8')));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ path: 'screenshot_expected.png', encoding: 'base64' });
      const png = Buffer.from(files[0]!.data, 'base64');
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(png.readUInt32BE(20)).toBe(3000);
      const next = await context.newPage();
      await next.setContent('<h1>Next test case</h1>');
      const nextScreenshot = await captureScreenshot(next);
      expect(nextScreenshot.data).toBeTruthy();
      await next.close();
    } finally {
      await browser.close();
      if (previousDirectory === undefined) delete process.env.WORKING_DIRECTORY_PATH;
      else process.env.WORKING_DIRECTORY_PATH = previousDirectory;
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
);
