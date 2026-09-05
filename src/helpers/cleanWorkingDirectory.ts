import fs from 'node:fs';
import path from 'node:path';

// Currently, it does not support changing file contents and deleting files.
export async function snapshotWorkingDirectory(cwd: string): Promise<ReadonlySet<string>> {
  const paths = await fs.promises.readdir(cwd, { recursive: true });
  return new Set(paths);
}

export async function cleanWorkingDirectory(cwd: string, snapshot: ReadonlySet<string>): Promise<void> {
  await cleanDirectory(cwd, '', snapshot);
}

async function cleanDirectory(dir: string, relativePrefix: string, snapshot: ReadonlySet<string>): Promise<void> {
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const relativePath = path.join(relativePrefix, entry.name);
    if (!snapshot.has(relativePath)) {
      // An unsnapshotted directory is removed whole, so its contents are never visited.
      await fs.promises.rm(path.join(dir, entry.name), { force: true, recursive: true });
    } else if (entry.isDirectory()) {
      await cleanDirectory(path.join(dir, entry.name), relativePath, snapshot);
    }
  }
}
