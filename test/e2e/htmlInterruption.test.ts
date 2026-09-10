import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { expect, test } from 'vitest';

test.each([
  ['before-directory', 'SIGINT'],
  ['before-directory', 'SIGTERM'],
  ['after-directory', 'SIGINT'],
  ['after-directory', 'SIGTERM'],
] as const)(
  'HTML serving lets the host finish shutdown when its handler is registered %s with %s',
  { timeout: 20_000 },
  async (stage, signal) => {
    await fs.mkdir('.tmp', { recursive: true });
    const root = await fs.mkdtemp(path.resolve('.tmp', 'html-interruption-'));
    await fs.writeFile(path.join(root, 'index.html'), '<p>Host shutdown content</p>');
    let servedPath: string | undefined;
    const child = spawn('bun', ['test/fixtures/htmlInterrupted/judge.ts', root, stage, signal], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      for await (const line of createInterface({ input: child.stdout })) {
        servedPath = line;
        break;
      }
      expect(servedPath, stderr).toBeDefined();
      child.kill(signal);
      const [exitCode] = await exited;
      expect(exitCode, stderr).toBe(0);
      expect(await fs.readFile(path.join(root, 'shutdown.txt'), 'utf8')).toBe('<p>Host shutdown content</p>');
      await expect(fs.stat(servedPath!)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(path.join(root, 'index.html'), 'utf8')).toBe('<p>Host shutdown content</p>');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
      if (servedPath) await fs.rm(servedPath, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);
