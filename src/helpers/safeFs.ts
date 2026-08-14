import fs from 'node:fs';
import path from 'node:path';

import { forceRemove } from './sandboxUser.js';

/**
 * Recursively copy `source` into `destination` without ever following a symlink that already
 * exists at a destination path. A sandboxed submission (running as a different OS user) can plant
 * such a symlink to redirect this trusted-user write outside its working directory, so every
 * pre-existing destination entry is lstat'd and unlinked (never followed) before being written.
 * Symlinks in the SOURCE are recreated as symlinks; their targets are never read.
 *
 * Merges into an existing destination directory (like `fs.cp(..., { recursive: true })`), but a
 * plain `fs.cp` follows destination symlinks nested inside directories, which this avoids.
 */
export async function copyWithoutFollowingSymlinks(source: string, destination: string): Promise<void> {
  const sourceStats = await fs.promises.lstat(source);

  if (sourceStats.isSymbolicLink()) {
    await removeExistingEntry(destination);
    await fs.promises.symlink(await fs.promises.readlink(source), destination);
    return;
  }

  if (sourceStats.isDirectory()) {
    // A pre-existing symlink (or file) at the destination is removed so the merge target is a real
    // directory the harness owns, not something the submission redirected.
    const existingDestinationStats = await lstatOrUndefined(destination);
    if (!existingDestinationStats?.isDirectory()) await removeExistingEntry(destination);
    await fs.promises.mkdir(destination, { recursive: true });
    for (const entry of await fs.promises.readdir(source)) {
      await copyWithoutFollowingSymlinks(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }

  await removeExistingEntry(destination);
  await fs.promises.copyFile(source, destination);
}

/**
 * Create `directory` and the missing levels between it and `root`, replacing anything that is not
 * already a real directory. `fs.mkdir(..., { recursive: true })` follows a symlink it finds on the
 * way, which a submission can plant to place a trusted-user write outside the tree; this walks the
 * levels one at a time instead. Only levels BELOW `root` are inspected, so an unrelated symlink
 * above the caller's tree (`/tmp` on macOS, for instance) is never touched. `root` must already be
 * a directory the harness trusts, and `directory` must be inside it.
 */
export async function createDirectoryWithoutFollowingSymlinks(root: string, directory: string): Promise<void> {
  const relativePath = path.relative(root, directory);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`directory must be inside root: ${directory} is not inside ${root}`);
  }

  let currentPath = root;
  for (const level of relativePath.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, level);
    const stats = await lstatOrUndefined(currentPath);
    if (stats?.isDirectory()) continue;
    if (stats) await removeExistingEntry(currentPath);
    await fs.promises.mkdir(currentPath);
  }
}

// `fs.rm` unlinks a symlink itself rather than following it, and removes files/directories
// otherwise; `forceRemove` adds the retry for entries a sandboxed submission left unreadable.
async function removeExistingEntry(target: string): Promise<void> {
  await forceRemove(target);
}

/** Whether `realTargetPath` is `realDirectoryPath` itself or below it. Both must be realpaths. */
export function isContainedPath(realDirectoryPath: string, realTargetPath: string): boolean {
  const relativePath = path.relative(realDirectoryPath, realTargetPath);
  // A bare `..`-prefix test would also reject an in-directory name like `..result`.
  return relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

async function lstatOrUndefined(target: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.lstat(target);
  } catch {
    return undefined;
  }
}
