import fs from 'node:fs';
import path from 'node:path';

import { forceRemove, relaxPermissionsAsSandboxUser, sandboxUserName } from './sandboxUser.js';

// Currently, it does not support changing file contents and deleting files.
export async function snapshotWorkingDirectory(cwd: string): Promise<ReadonlySet<string>> {
  const snapshot = new Set<string>();
  await collectEntries(cwd, cwd, snapshot);
  return snapshot;
}

export async function cleanWorkingDirectory(cwd: string, snapshot: ReadonlySet<string>): Promise<void> {
  await removeUnsnapshotted(cwd, cwd, snapshot);
}

async function collectEntries(root: string, dir: string, into: Set<string>): Promise<void> {
  for (const entry of await readdirWithTypes(dir)) {
    const absolutePath = path.join(dir, entry.name);
    into.add(path.relative(root, absolutePath));
    // Never descend into a symlink: a sandboxed submission could point it outside the directory.
    if (entry.isDirectory()) await collectEntries(root, absolutePath, into);
  }
}

async function removeUnsnapshotted(root: string, dir: string, snapshot: ReadonlySet<string>): Promise<void> {
  for (const entry of await readdirWithTypes(dir)) {
    const absolutePath = path.join(dir, entry.name);
    if (!snapshot.has(path.relative(root, absolutePath))) {
      // `absolutePath` has no symlink ancestor (we only recurse into real directories), and
      // `forceRemove`/`fs.rm` unlinks a leaf symlink instead of following it, so this cannot delete
      // outside the working directory even if the submission planted symlinks.
      await forceRemove(absolutePath);
      continue;
    }
    if (entry.isDirectory()) await removeUnsnapshotted(root, absolutePath, snapshot);
  }
}

/**
 * `readdir` with entry types (which reflect `lstat`, so a symlink reads as a symlink, not a
 * directory), with a fallback for directories a sandboxed process made untraversable.
 */
async function readdirWithTypes(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (!sandboxUserName) throw error;
    relaxPermissionsAsSandboxUser(dir);
    return await fs.promises.readdir(dir, { withFileTypes: true });
  }
}
