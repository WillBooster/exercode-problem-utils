import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';

// Files the judge importer skips when reading problem directories. The extension filter is ported
// from the judge's readSourceCodeFilesInDirectory so compile artifacts (e.g. Main.class next to
// Main.java) are excluded from pattern checks exactly like the judge excludes them at import time;
// the '' entry also drops dot files such as `.DS_Store`, whose extension is ''.
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

/** Whether the path is a regular file (not a symlink), as the judge's problem discovery requires. */
export async function isRegularFile(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isFile();
  } catch {
    return false;
  }
}

/** Whether the path is a directory that is not a symbolic link, which the judge's discovery does not traverse. */
export async function isRegularDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isDirectory();
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

/**
 * Collects the IDs of the problem definitions under a directory the way the judge discovers them:
 * `problem.md` names its directory and `<id>.problem.md` names itself, at any depth, without
 * traversing symbolic links.
 */
export async function collectProblemIds(rootDirectoryPath: string): Promise<Set<string>> {
  const problemIds = new Set<string>();
  await collectProblemIdsInto(rootDirectoryPath, problemIds);
  return problemIds;
}

async function collectProblemIdsInto(directoryPath: string, problemIds: Set<string>): Promise<void> {
  for (const dirent of await readdir(directoryPath, { withFileTypes: true })) {
    if (dirent.isFile()) {
      if (dirent.name === 'problem.md') problemIds.add(basename(directoryPath));
      else if (dirent.name.endsWith('.problem.md')) problemIds.add(dirent.name.slice(0, -'.problem.md'.length));
    } else if (dirent.isDirectory() && dirent.name !== 'node_modules' && !dirent.name.startsWith('.')) {
      await collectProblemIdsInto(join(directoryPath, dirent.name), problemIds);
    }
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
    } else if (dirent.isFile() && !NON_CODE_EXTENSIONS.has(extname(dirent.name).toLowerCase())) {
      files.push({ path: relative(rootDirectoryPath, entryPath), data: await readFile(entryPath, 'utf8') });
    }
  }
}
