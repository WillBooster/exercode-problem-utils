import fs from 'node:fs/promises';
import path from 'node:path';

import { createHtmlServedDirectory } from '@exercode/problem-utils-browser';
import { expect, test } from 'vitest';

test('served HTML includes shared assets, preserves overrides and resolves relative links', async () => {
  await fs.mkdir('.tmp', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.tmp', 'html-assets-'));
  try {
    const assets = path.join(root, 'assets');
    const submission = path.join(root, 'problem', 'answer');
    await fs.mkdir(assets, { recursive: true });
    await fs.mkdir(submission, { recursive: true });
    await fs.writeFile(path.join(assets, 'image.svg'), '<svg>shared image</svg>');
    await fs.writeFile(path.join(assets, 'style.css'), 'body { color: blue; }');
    await fs.writeFile(path.join(submission, 'style.css'), 'body { color: red; }');
    await fs.symlink('style.css', path.join(submission, 'alias.css'));
    await using served = await createHtmlServedDirectory(submission);
    expect(await fs.readFile(path.join(served.path, 'assets', 'image.svg'), 'utf8')).toBe('<svg>shared image</svg>');
    expect(await fs.readFile(path.join(served.path, 'image.svg'), 'utf8')).toBe('<svg>shared image</svg>');
    expect(await fs.readFile(path.join(served.path, 'style.css'), 'utf8')).toBe('body { color: red; }');
    expect(await fs.readFile(path.join(served.path, 'alias.css'), 'utf8')).toBe('body { color: red; }');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
