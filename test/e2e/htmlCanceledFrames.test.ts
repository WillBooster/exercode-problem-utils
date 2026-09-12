import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { z } from 'zod';

test('HTML screenshots survive canceled frame requests without aborting the harness', { timeout: 30_000 }, async () => {
  const { stdout } = await promisify(execFile)('bun', ['test/fixtures/htmlCanceledFrames/judge.ts'], {
    timeout: 25_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const screenshots = z.array(z.string()).length(2).parse(JSON.parse(stdout));
  for (const screenshot of screenshots) {
    const png = Buffer.from(screenshot, 'base64');
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.readUInt32BE(16)).toBe(1280);
    expect(png.readUInt32BE(20)).toBe(720);
  }
});
