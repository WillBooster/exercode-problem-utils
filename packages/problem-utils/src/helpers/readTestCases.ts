import fs from 'node:fs';
import path from 'node:path';

const SHARED_TEST_CASE_NAME = '_shared';

/**
 * Read the test cases of a `test_cases/` directory. A test case id is the name of every
 * `<id>.in` / `<id>.out` file and `<id>.fin/` / `<id>.fout/` directory; any of them may be absent,
 * and what an absent part means is up to the harness (the presets document their rules).
 * Other entries (e.g. `.json` configuration read by a custom `judge.ts`) are ignored.
 */
export async function readTestCases(directory: string): Promise<
  { id: string; input?: string; output?: string; fileInputPath?: string; fileOutputPath?: string }[] & {
    shared?: { fileInputPath?: string };
  }
> {
  if (!fs.existsSync(directory)) return [];

  const idSet = new Set<string>();
  const idToInput = new Map<string, string>();
  const idToOutput = new Map<string, string>();
  const idToFileInputPath = new Map<string, string>();
  const idToFileOutputPath = new Map<string, string>();

  for (const dirent of await fs.promises.readdir(directory, { withFileTypes: true })) {
    if (dirent.isFile()) {
      const { ext, name } = path.parse(dirent.name);
      if (ext !== '.in' && ext !== '.out') continue;

      const text = await fs.promises.readFile(path.join(dirent.parentPath, dirent.name), 'utf8');

      idSet.add(name);
      if (ext === '.in') idToInput.set(name, text);
      if (ext === '.out') idToOutput.set(name, text);
    } else if (dirent.isDirectory()) {
      const { ext, name } = path.parse(dirent.name);
      if (ext !== '.fin' && ext !== '.fout') continue;

      idSet.add(name);
      if (ext === '.fin') idToFileInputPath.set(name, path.join(dirent.parentPath, dirent.name));
      if (ext === '.fout') idToFileOutputPath.set(name, path.join(dirent.parentPath, dirent.name));
    }
  }

  const testCases: Awaited<ReturnType<typeof readTestCases>> = [...idSet]
    .filter((id) => id !== SHARED_TEST_CASE_NAME)
    .toSorted()
    .map((id) => ({
      id,
      input: idToInput.get(id),
      output: idToOutput.get(id),
      fileInputPath: idToFileInputPath.get(id),
      fileOutputPath: idToFileOutputPath.get(id),
    }));

  if (idSet.has(SHARED_TEST_CASE_NAME)) {
    testCases.shared = { fileInputPath: idToFileInputPath.get(SHARED_TEST_CASE_NAME) };
  }

  return testCases;
}
