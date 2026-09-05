import fs from 'node:fs';

export async function copyTestCaseFileInput(fileInputPath: string, cwd: string): Promise<void> {
  await fs.promises.cp(fileInputPath, cwd, { force: true, recursive: true });
}
