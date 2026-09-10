import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createTemporaryDirectory(prefix: string): { path: string; [Symbol.asyncDispose](): Promise<void> } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    path: directory,
    async [Symbol.asyncDispose]() {
      await fs.promises.rm(directory, { recursive: true, force: true });
    },
  };
}
