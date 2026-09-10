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

test('submitted files and dangling links override shared directories and files', async () => {
  await fs.mkdir('.tmp', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.tmp', 'html-overrides-'));
  try {
    const assets = path.join(root, 'assets');
    const submission = path.join(root, 'answer');
    await fs.mkdir(path.join(assets, 'images'), { recursive: true });
    await fs.mkdir(submission);
    await fs.writeFile(path.join(assets, 'images', 'shared.txt'), 'shared');
    await fs.writeFile(path.join(assets, 'broken.txt'), 'fallback');
    await fs.writeFile(path.join(submission, 'images'), 'submitted file');
    await fs.symlink('missing.txt', path.join(submission, 'broken.txt'));
    await using served = await createHtmlServedDirectory(submission);
    expect(await fs.readFile(path.join(served.path, 'images'), 'utf8')).toBe('submitted file');
    await expect(fs.readFile(path.join(served.path, 'broken.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('local assets combine with the nearest ancestor asset directory', async () => {
  await fs.mkdir('.tmp', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.tmp', 'html-local-assets-'));
  try {
    const assets = path.join(root, 'assets');
    const problem = path.join(root, 'problem');
    const submission = path.join(problem, 'answer');
    await fs.mkdir(assets);
    await fs.mkdir(path.join(submission, 'assets'), { recursive: true });
    await fs.writeFile(path.join(problem, 'assets'), 'metadata, not a directory');
    await fs.writeFile(path.join(assets, 'shared.txt'), 'shared');
    await fs.writeFile(path.join(assets, 'own.txt'), 'shared version');
    await fs.writeFile(path.join(submission, 'assets', 'own.txt'), 'own version');
    await using served = await createHtmlServedDirectory(submission);
    expect(await fs.readFile(path.join(served.path, 'assets', 'shared.txt'), 'utf8')).toBe('shared');
    expect(await fs.readFile(path.join(served.path, 'shared.txt'), 'utf8')).toBe('shared');
    expect(await fs.readFile(path.join(served.path, 'assets', 'own.txt'), 'utf8')).toBe('own version');
    expect(await fs.readFile(path.join(served.path, 'own.txt'), 'utf8')).toBe('own version');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('asset assembly and disposal leave linked source directories unchanged', async () => {
  await fs.mkdir('.tmp', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.tmp', 'html-linked-assets-'));
  try {
    const assets = path.join(root, 'assets');
    const submission = path.join(root, 'answer');
    const target = path.join(root, 'target');
    await fs.mkdir(path.join(assets, 'images'), { recursive: true });
    await fs.mkdir(submission);
    await fs.mkdir(target);
    await fs.writeFile(path.join(assets, 'images', 'shared.txt'), 'shared');
    await fs.writeFile(path.join(target, 'own.txt'), 'own');
    await fs.symlink('../target', path.join(submission, 'images'));
    {
      await using served = await createHtmlServedDirectory(submission);
      expect(await fs.readFile(path.join(served.path, 'images', 'own.txt'), 'utf8')).toBe('own');
    }
    expect(await fs.readdir(target)).toEqual(['own.txt']);
    expect(await fs.readFile(path.join(target, 'own.txt'), 'utf8')).toBe('own');
    expect(await fs.readFile(path.join(assets, 'images', 'shared.txt'), 'utf8')).toBe('shared');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('relative asset links resolve through the real shared asset directory', async () => {
  await fs.mkdir('.tmp', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.tmp', 'html-asset-alias-'));
  try {
    const store = path.join(root, 'store');
    const problem = path.join(root, 'problem');
    const submission = path.join(problem, 'answer');
    await fs.mkdir(path.join(store, 'assets'), { recursive: true });
    await fs.mkdir(submission, { recursive: true });
    await fs.writeFile(path.join(store, 'target.txt'), 'shared target');
    await fs.symlink('../target.txt', path.join(store, 'assets', 'item.txt'));
    await fs.symlink('../store/assets', path.join(problem, 'assets'));
    await using served = await createHtmlServedDirectory(submission);
    expect(await fs.readFile(path.join(served.path, 'assets', 'item.txt'), 'utf8')).toBe('shared target');
    expect(await fs.readFile(path.join(served.path, 'item.txt'), 'utf8')).toBe('shared target');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
