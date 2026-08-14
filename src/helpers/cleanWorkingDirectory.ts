import fs from 'node:fs';
import path from 'node:path';

import { forceRemove } from './sandboxUser.js';

// Currently, it does not support changing file contents and deleting files.
export async function snapshotWorkingDirectory(cwd: string): Promise<ReadonlySet<string>> {
  const paths = await fs.promises.readdir(cwd, { recursive: true });
  return new Set(paths);
}

export async function cleanWorkingDirectory(cwd: string, snapshot: ReadonlySet<string>): Promise<void> {
  for (const p of await fs.promises.readdir(cwd, { recursive: true })) {
    if (snapshot.has(p)) continue;
    await forceRemove(path.join(cwd, p));
  }
}
