import fs from 'node:fs';
import path from 'node:path';

// Currently, it does not support changing file contents and deleting files.
export async function snapshotWorkingDirectory(cwd: string): Promise<ReadonlySet<string>> {
  const paths = await fs.promises.readdir(cwd, { recursive: true });
  return new Set(paths);
}

export async function cleanWorkingDirectory(cwd: string, snapshot: ReadonlySet<string>): Promise<void> {
  for (const entry of await fs.promises.readdir(cwd, { withFileTypes: true })) {
    const entryPath = path.join(cwd, entry.name);
    if (!snapshot.has(path.relative(cwd, entryPath))) {
      // An unsnapshotted directory is removed whole, so its contents are never visited.
      await fs.promises.rm(entryPath, { force: true, recursive: true });
    } else if (entry.isDirectory()) {
      await cleanWorkingDirectory(entryPath, prefixedSnapshot(snapshot, entry.name));
    }
  }
}

function prefixedSnapshot(snapshot: ReadonlySet<string>, directoryName: string): ReadonlySet<string> {
  const prefix = `${directoryName}${path.sep}`;
  return new Set([...snapshot].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)));
}
