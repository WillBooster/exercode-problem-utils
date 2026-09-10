import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { startHttpServer } from '@exercode/problem-utils';
import { markdownToPdf } from '@exercode/problem-utils-browser/pdf';

test('PDF export loads relative assets with Japanese names, spaces and literal percent signs', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdf-assets-'));
  try {
    const fileName = '画像 100%.svg';
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="red"/></svg>';
    await writeFile(path.join(directory, fileName), svg);
    await using server = startHttpServer(directory);
    const response = await fetch(`${server.url}/${encodeURIComponent(fileName)}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(svg);
    const pdf = await markdownToPdf(`# Asset export\n\n![Illustration](<${fileName}>)`, {
      assetDirectoryPath: directory,
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
    const malformed = await fetch(`${server.url}/%FF`);
    expect(malformed.status).toBe(400);
    const subsequentResponse = await fetch(`${server.url}/${encodeURIComponent(fileName)}`);
    expect(subsequentResponse.status).toBe(200);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
