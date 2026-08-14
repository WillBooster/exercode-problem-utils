import fs from 'node:fs';

import { makeAccessibleToSandboxUser } from './sandboxUser.js';

export async function copyTestCaseFileInput(fileInputPath: string, cwd: string): Promise<void> {
  await fs.promises.cp(fileInputPath, cwd, { force: true, recursive: true });
  // The copied files are owned by the harness user; the sandboxed submission must read them and
  // may create outputs in the copied directories.
  makeAccessibleToSandboxUser(cwd);
}
