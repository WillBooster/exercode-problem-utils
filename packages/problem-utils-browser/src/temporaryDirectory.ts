import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directories = new Set<string>();
const exitOnSigint = (): never => process.exit(130);
const exitOnSigterm = (): never => process.exit(143);

export function createTemporaryDirectory(prefix: string): { path: string; [Symbol.asyncDispose](): Promise<void> } {
  // Register before yielding: a signal must not land between creation and ownership registration.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (directories.size === 0) {
    process.once('exit', removeDirectories);
    process.once('SIGINT', exitOnSigint);
    process.once('SIGTERM', exitOnSigterm);
  }
  directories.add(directory);
  return {
    path: directory,
    async [Symbol.asyncDispose]() {
      await fs.promises.rm(directory, { recursive: true, force: true });
      directories.delete(directory);
      if (directories.size === 0) {
        process.off('exit', removeDirectories);
        process.off('SIGINT', exitOnSigint);
        process.off('SIGTERM', exitOnSigterm);
      }
    },
  };
}

function removeDirectories(): void {
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
}
