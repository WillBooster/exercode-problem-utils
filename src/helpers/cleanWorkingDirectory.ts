import fs from 'node:fs';
import path from 'node:path';

import { forceRemove, relaxPermissionsAsSandboxUser, sandboxUserName } from './sandboxUser.js';

/** Snapshot of the working directory: each entry's relative path and the kind of entry it was. */
export type WorkingDirectorySnapshot = ReadonlyMap<string, WorkingDirectoryEntryKind>;

type WorkingDirectoryEntryKind = 'directory' | 'file' | 'symlink' | 'other';

// Currently, it does not support changing file contents and deleting files.
export async function snapshotWorkingDirectory(cwd: string): Promise<WorkingDirectorySnapshot> {
  const snapshot = new Map<string, WorkingDirectoryEntryKind>();
  await collectEntries(cwd, cwd, snapshot);
  return snapshot;
}

export async function cleanWorkingDirectory(cwd: string, snapshot: WorkingDirectorySnapshot): Promise<void> {
  await removeUnsnapshotted(cwd, cwd, snapshot);
}

async function collectEntries(root: string, dir: string, into: Map<string, WorkingDirectoryEntryKind>): Promise<void> {
  for (const entry of await readdirWithTypes(dir)) {
    const absolutePath = path.join(dir, entry.name);
    into.set(path.relative(root, absolutePath), toEntryKind(entry));
    // Never descend into a symlink: a sandboxed submission could point it outside the directory.
    if (entry.isDirectory()) await collectEntries(root, absolutePath, into);
  }
}

async function removeUnsnapshotted(root: string, dir: string, snapshot: WorkingDirectorySnapshot): Promise<void> {
  for (const entry of await readdirWithTypes(dir)) {
    const absolutePath = path.join(dir, entry.name);
    const snapshottedKind = snapshot.get(path.relative(root, absolutePath));
    // The kind must still match: a sandboxed submission can replace one of its own snapshotted
    // entries with a symlink, and matching by path alone would preserve it across test cases.
    if (snapshottedKind === undefined || snapshottedKind !== toEntryKind(entry)) {
      // `absolutePath` has no symlink ancestor (we only recurse into real directories), and
      // `forceRemove`/`fs.rm` unlinks a leaf symlink instead of following it, so this cannot delete
      // outside the working directory even if the submission planted symlinks.
      await forceRemove(absolutePath);
      continue;
    }
    if (entry.isDirectory()) await removeUnsnapshotted(root, absolutePath, snapshot);
  }
}

function toEntryKind(entry: fs.Dirent): WorkingDirectoryEntryKind {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  return 'other';
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
