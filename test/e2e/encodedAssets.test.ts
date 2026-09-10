import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { startHttpServer } from '@exercode/problem-utils';
import { markdownToPdf } from '@exercode/problem-utils-browser/pdf';

test(
  'PDF export loads relative assets with Japanese names, spaces and literal percent signs',
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdf-assets-'));
    try {
      const fileName = '画像 100%.png';
      const image = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAHgAAAAoCAYAAAA16j4lAAAAtklEQVR4AezTwQnAMAwEQeH+e3ZABaSA9QTi/96gc2euv7vBGV96AcBp3hnAgOMLxPNcMOD4AvE8Fww4ucAzUS44Tg0YcHyBeJ4LBhxfIJ7nggHHF4jnueC3gOO1D+a54Dg6YMDxBeJ5LhhwfIF4ngsGHF8gnueCF7j7AO7abhngnaH7AO7abhngnaH7AO7abhngnaH7AO7abhngnaH7/AN3u58pAxynBgw4vkA8zwUDji8Qz/sAAAD//1ki9rAAAAAGSURBVAMA2QrvYQP6pkYAAAAASUVORK5CYII=',
        'base64'
      );
      await writeFile(path.join(directory, fileName), image);
      await using server = startHttpServer(directory);
      const response = await fetch(`${server.url}/${encodeURIComponent(fileName)}`);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(image);
      const pdf = await markdownToPdf(`# Asset export\n\n![Illustration](<${fileName}>)`, {
        assetDirectoryPath: directory,
        pdfOptions: { width: '400px', height: '600px', margin: { top: 0, right: 0, bottom: 0, left: 0 } },
      });
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(pdf.toString('latin1')).toMatch(/\/MediaBox\s*\[0 0 300 450\]/);
      expect(pdf.toString('latin1')).toMatch(/\/Subtype\s*\/Image/);
      expect(pdf.toString('latin1')).toMatch(/\/Width\s+120\b/);
      expect(pdf.toString('latin1')).toMatch(/\/Height\s+40\b/);
      const malformed = await fetch(`${server.url}/%FF`);
      expect(malformed.status).toBe(400);
      const subsequentResponse = await fetch(`${server.url}/${encodeURIComponent(fileName)}`);
      expect(subsequentResponse.status).toBe(200);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test('PDF export still produces a page when images are missing or invalid', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdf-broken-assets-'));
  try {
    await writeFile(path.join(directory, 'broken.png'), 'not an image');
    const pdf = await markdownToPdf(
      '# Export with unavailable illustrations\n\n![Missing](missing.png)\n\n![Broken](broken.png)',
      {
        assetDirectoryPath: directory,
      }
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toMatch(/\/Type\s*\/Page\b/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
