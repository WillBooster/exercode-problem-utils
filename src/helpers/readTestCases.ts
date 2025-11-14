import fs from 'node:fs';
import path from 'node:path';

export async function readTestCases(directory: string): Promise<{ id: string; stdin?: string; stdout?: string }[]> {
  const idSet = new Set<string>();
  const idToStdin = new Map<string, string>();
  const idToStdout = new Map<string, string>();

  for (const dirent of await fs.promises.readdir(directory, { withFileTypes: true })) {
    if (!dirent.isFile()) continue;

    const { ext, name } = path.parse(dirent.name);
    if (ext !== '.in' && ext !== '.out') continue;

    const text = await fs.promises.readFile(path.join(dirent.parentPath, dirent.name), 'utf8');

    idSet.add(name);
    if (ext === '.in') idToStdin.set(name, text);
    if (ext === '.out') idToStdout.set(name, text);
  }

  return [...idSet].toSorted().map((id) => ({ id, stdin: idToStdin.get(id), stdout: idToStdout.get(id) }));
}
