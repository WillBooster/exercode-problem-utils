import fs from 'node:fs';
import path from 'node:path';

import { forceRemove, relaxPermissionsAsSandboxUser, sandboxUserName } from './sandboxUser.js';

/** Snapshot of the working directory: each entry's relative path and whether it was a directory. */
export type WorkingDirectorySnapshot = ReadonlyMap<string, boolean>;

// Currently, it does not support changing file contents and deleting files.
export async function snapshotWorkingDirectory(cwd: string): Promise<WorkingDirectorySnapshot> {
  const snapshot = new Map<string, boolean>();
  await collectEntries(cwd, cwd, snapshot);
  return snapshot;
}

export async function cleanWorkingDirectory(cwd: string, snapshot: WorkingDirectorySnapshot): Promise<void> {
  await removeUnsnapshotted(cwd, cwd, snapshot);
}

async function collectEntries(root: string, dir: string, into: Map<string, boolean>): Promise<void> {
  for (const entry of await readdirWithTypes(dir)) {
    const absolutePath = path.join(dir, entry.name);
    into.set(path.relative(root, absolutePath), entry.isDirectory());
    // Never descend into a symlink: a sandboxed submission could point it outside the directory.
    if (entry.isDirectory()) await collectEntries(root, absolutePath, into);
  }
}

async function removeUnsnapshotted(root: string, dir: string, snapshot: WorkingDirectorySnapshot): Promise<void> {
  for (const entry of await readdirWithTypes(dir)) {
    const absolutePath = path.join(dir, entry.name);
    const snapshottedAsDirectory = snapshot.get(path.relative(root, absolutePath));
    // The type must still match: a sandboxed submission can replace one of its own snapshotted
    // entries with a symlink, and matching by path alone would preserve it across test cases.
    if (snapshottedAsDirectory === undefined || snapshottedAsDirectory !== entry.isDirectory()) {
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
