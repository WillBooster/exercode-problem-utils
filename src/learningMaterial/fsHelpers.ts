import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

// Files the judge importer skips when reading problem directories. The extension filter is ported
// from the judge's readSourceCodeFilesInDirectory so compile artifacts (e.g. Main.class next to
// Main.java) are excluded from pattern checks exactly like the judge excludes them at import time.
const IGNORED_FILE_NAMES: ReadonlySet<string> = new Set(['.DS_Store']);
const IGNORED_DIRECTORY_NAMES: ReadonlySet<string> = new Set(['__pycache__']);
const NON_CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  '',
  '.class',
  '.exe',
  '.jar',
  '.out',
  '.pyc',
  '.png',
  '.gif',
]);

export interface SourceFile {
  path: string;
  data: string;
}

export async function isFile(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isFile();
  } catch {
    return false;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/** Reads all text files under a directory, with paths relative to the given root. */
export async function readSourceFilesRecursively(rootDirectoryPath: string): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  await collectSourceFiles(rootDirectoryPath, rootDirectoryPath, files);
  return files.toSorted((f1, f2) => f1.path.localeCompare(f2.path));
}

async function collectSourceFiles(
  rootDirectoryPath: string,
  directoryPath: string,
  files: SourceFile[]
): Promise<void> {
  for (const dirent of await readdir(directoryPath, { withFileTypes: true })) {
    const entryPath = join(directoryPath, dirent.name);
    if (dirent.isDirectory()) {
      if (!IGNORED_DIRECTORY_NAMES.has(dirent.name)) {
        await collectSourceFiles(rootDirectoryPath, entryPath, files);
      }
    } else if (
      dirent.isFile() &&
      !IGNORED_FILE_NAMES.has(dirent.name) &&
      !NON_CODE_EXTENSIONS.has(extname(dirent.name).toLowerCase())
    ) {
      files.push({ path: relative(rootDirectoryPath, entryPath), data: await readFile(entryPath, 'utf8') });
    }
  }
}
