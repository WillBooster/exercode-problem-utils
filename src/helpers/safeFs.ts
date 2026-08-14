import fs from 'node:fs';
import path from 'node:path';

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

// `fs.rm` unlinks a symlink itself rather than following it, and removes files/directories otherwise.
async function removeExistingEntry(target: string): Promise<void> {
  await fs.promises.rm(target, { force: true, recursive: true });
}

async function lstatOrUndefined(target: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.lstat(target);
  } catch {
    return undefined;
  }
}
