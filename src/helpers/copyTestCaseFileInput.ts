import { makeAccessibleToSandboxUser } from './sandboxUser.js';
import { copyWithoutFollowingSymlinks } from './safeFs.js';

export async function copyTestCaseFileInput(fileInputPath: string, cwd: string): Promise<void> {
  // A no-follow copy: a sandboxed submission may have planted a symlink at one of these
  // destination paths to redirect this trusted-user write outside its working directory.
  await copyWithoutFollowingSymlinks(fileInputPath, cwd);
  // The copied files are owned by the harness user; the sandboxed submission must read them and
  // may create outputs in the copied directories.
  makeAccessibleToSandboxUser(cwd);
}
