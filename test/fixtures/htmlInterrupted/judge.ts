import fs from 'node:fs/promises';
import path from 'node:path';

import { startHttpServer } from '@exercode/problem-utils';
import { createHtmlServedDirectory } from '@exercode/problem-utils-browser';

const root = process.argv[2]!;
const signal = process.argv[4];
if (signal !== 'SIGINT' && signal !== 'SIGTERM') throw new Error('Expected a termination signal');
let directory: Awaited<ReturnType<typeof createHtmlServedDirectory>>;
let server: ReturnType<typeof startHttpServer>;
let onSignal: () => void;
const shutdown = new Promise<void>((resolve, reject) => {
  onSignal = () => {
    void finishShutdown().then(resolve, reject);
  };
});
if (process.argv[3] === 'before-directory') process.once(signal, onSignal!);
directory = await createHtmlServedDirectory(root);
server = startHttpServer(directory.path);
if (process.argv[3] === 'after-directory') process.once(signal, onSignal!);
console.log(directory.path);
await shutdown;

async function finishShutdown(): Promise<void> {
  const content = await fs.readFile(path.join(directory.path, 'index.html'), 'utf8');
  await fs.writeFile(path.join(root, 'shutdown.txt'), content);
  await server[Symbol.asyncDispose]();
  await directory[Symbol.asyncDispose]();
}
