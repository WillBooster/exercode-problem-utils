import fs from 'node:fs';
import path from 'node:path';

import { forceRemove, relaxPermissionsAsSandboxUser, sandboxUserName } from './sandboxUser.js';

// Currently, it does not support changing file contents and deleting files.
export async function snapshotWorkingDirectory(cwd: string): Promise<ReadonlySet<string>> {
  return new Set(await readdirRecursive(cwd));
}

export async function cleanWorkingDirectory(cwd: string, snapshot: ReadonlySet<string>): Promise<void> {
  for (const p of await readdirRecursive(cwd)) {
    if (snapshot.has(p)) continue;
    await forceRemove(path.join(cwd, p));
  }
}

/**
 * Recursive readdir with a fallback for directories a sandboxed process created with restrictive
 * permissions, which the harness user cannot traverse.
 */
async function readdirRecursive(cwd: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(cwd, { recursive: true });
  } catch (error) {
    if (!sandboxUserName) throw error;
    relaxPermissionsAsSandboxUser(cwd);
    return await fs.promises.readdir(cwd, { recursive: true });
  }
}
