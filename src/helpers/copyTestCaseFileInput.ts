import fs from 'node:fs';

import { copyWithoutFollowingSymlinks } from './safeFs.js';
import { makeAccessibleToSandboxUser } from './sandboxUser.js';

export async function copyTestCaseFileInput(fileInputPath: string, cwd: string): Promise<void> {
  // `readTestCases` only ever yields a `.fin` directory here, and the destination is the working
  // directory itself, so a file-typed source would mean replacing that whole directory with a file.
  const fileInputStats = await fs.promises.stat(fileInputPath);
  if (!fileInputStats.isDirectory()) {
    throw new Error(`test case file input must be a directory: ${fileInputPath}`);
  }
  // A no-follow copy: a sandboxed submission may have planted a symlink at one of these
  // destination paths to redirect this trusted-user write outside its working directory.
  await copyWithoutFollowingSymlinks(fileInputPath, cwd);
  // The copied files are owned by the harness user; the sandboxed submission must read them and
  // may create outputs in the copied directories.
  makeAccessibleToSandboxUser(cwd);
}
