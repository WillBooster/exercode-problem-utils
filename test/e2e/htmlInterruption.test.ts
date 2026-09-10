import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { expect, test } from 'vitest';

test.each([
  ['before-browser', 'SIGINT'],
  ['before-browser', 'SIGTERM'],
  ['browser', 'SIGINT'],
  ['browser', 'SIGTERM'],
] as const)('HTML assets are removed after interrupting %s with %s', { timeout: 20_000 }, async (stage, signal) => {
  await fs.mkdir('.tmp', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.tmp', 'html-interruption-'));
  await fs.writeFile(path.join(root, 'index.html'), '<script>console.log("READY"); while (true) {}</script>');
  let servedPath: string | undefined;
  const child = spawn('bun', ['test/fixtures/htmlInterrupted/judge.ts', root, stage], {
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
    await exited;
    await expect(fs.stat(servedPath!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(root, 'index.html'), 'utf8')).toContain('READY');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    if (servedPath) await fs.rm(servedPath, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});
