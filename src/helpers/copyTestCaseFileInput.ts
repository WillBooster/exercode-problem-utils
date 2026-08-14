import fs from 'node:fs';

import { copyWithoutFollowingSymlinks } from './safeFs.js';
import { makeAccessibleToSandboxUser } from './sandboxUser.js';

export async function copyTestCaseFileInput(fileInputPath: string, cwd: string): Promise<void> {
  // `readTestCases` only ever yields a real `.fin` directory here (it selects entries by
  // `dirent.isDirectory()`, which does not follow links), and the destination is the working
  // directory itself, so anything else would mean replacing that whole directory — with a file, or
  // with a symlink to the problem's test cases. `lstat`, not `stat`: the latter resolves a symlink
  // source and would report it as a directory.
  const fileInputStats = await fs.promises.lstat(fileInputPath);
  if (!fileInputStats.isDirectory()) {
    throw new Error(`test case file input must be a directory, not a symlink or file: ${fileInputPath}`);
  }
  // A no-follow copy: a sandboxed submission may have planted a symlink at one of these
  // destination paths to redirect this trusted-user write outside its working directory.
  await copyWithoutFollowingSymlinks(fileInputPath, cwd);
  // The copied files are owned by the harness user; the sandboxed submission must read them and
  // may create outputs in the copied directories.
  makeAccessibleToSandboxUser(cwd);
}
