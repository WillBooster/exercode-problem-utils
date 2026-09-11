import { spawnSync } from 'node:child_process';

import { expect, test } from 'vitest';

test('the CommonJS PDF entry point generates a PDF in Node.js', { timeout: 30_000 }, () => {
  const result = spawnSync('node', ['test/fixtures/markdownPdf.cjs'], { timeout: 20_000 });
  expect(result.status, result.stderr.toString()).toBe(0);
  expect(result.stdout.subarray(0, 5).toString()).toBe('%PDF-');
});
