import fs from 'node:fs';
import path from 'node:path';

// Currently, it does not support changing file contents and deleting files.
export async function snapshotWorkingDirectory(cwd: string): Promise<ReadonlySet<string>> {
  const paths = await fs.promises.readdir(cwd, { recursive: true });
  return new Set(paths);
}

export async function cleanWorkingDirectory(cwd: string, snapshot: ReadonlySet<string>): Promise<void> {
  for (const p of await fs.promises.readdir(cwd, { recursive: true })) {
    if (snapshot.has(p)) continue;
    await fs.promises.rm(path.join(cwd, p), { force: true, recursive: true });
  }
}
