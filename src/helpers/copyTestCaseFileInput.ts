import fs from 'node:fs/promises';

export async function copyTestCaseFileInput(fileInputPath: string, cwd: string): Promise<void> {
  await fs.cp(fileInputPath, cwd, { force: true, recursive: true });
}
