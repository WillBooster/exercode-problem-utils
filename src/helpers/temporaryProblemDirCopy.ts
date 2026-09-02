import child_process from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Copy a problem directory into a temporary root, symlinking every ancestor `node_modules` so the
 * copied harness still resolves its imports. Callers must remove the returned `tempRoot`.
 */
export async function copyProblemDirToTemporaryRoot(
  problemDir: string,
  options: {
    /** Called as soon as the root exists, so a caller's signal cleanup can cover the copy phase too. */
    onTempRootCreated?: (tempRoot: string) => void;
  } = {}
): Promise<{ tempRoot: string; copiedProblemDir: string }> {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'problem-utils-isolation_'));
  options.onTempRootCreated?.(tempRoot);
  try {
    const absoluteProblemDir = path.resolve(problemDir);
    const copiedProblemDir = path.join(tempRoot, toTempRelativePath(absoluteProblemDir));
    await fs.promises.mkdir(path.dirname(copiedProblemDir), { recursive: true });
    await fs.promises.cp(absoluteProblemDir, copiedProblemDir, {
      recursive: true,
      filter: rejectAbsoluteSymlinks,
      // Keep relative symlinks relative: the default rewrites them to absolute paths into the
      // source tree, so judging the copy could write through them into the checked repository.
      verbatimSymlinks: true,
    });
    await symlinkAllAncestorNodeModules(tempRoot, absoluteProblemDir);
    return { tempRoot, copiedProblemDir };
  } catch (error) {
    await forciblyRemoveDirectory(tempRoot);
    throw error;
  }
}

/**
 * Remove a temporary directory even when judged code left permission-locked entries in it (e.g. a
 * mode-000 directory makes a plain `fs.rm` fail with EACCES). Returns whether removal succeeded.
 */
export async function forciblyRemoveDirectory(dir: string): Promise<boolean> {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    unlockPermissions(dir);
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

/** Synchronous variant of {@link forciblyRemoveDirectory} for signal handlers. */
export function forciblyRemoveDirectorySync(dir: string): boolean {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    unlockPermissions(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

// chmod does not exist on Windows, where POSIX-mode locks cannot occur anyway. spawnSync reports
// spawn failures via its return value instead of throwing, so no try/catch is needed.
function unlockPermissions(dir: string): void {
  if (process.platform !== 'win32') child_process.spawnSync('chmod', ['-R', 'u+rwX', dir]);
}

// An absolute symlink is copied verbatim, so judging the copy could write through it into the
// original tree; reject it instead of silently breaking the isolation guarantee.
async function rejectAbsoluteSymlinks(src: string): Promise<boolean> {
  if (!isCopiedProblemPath(src)) return false;
  const stats = await fs.promises.lstat(src);
  if (stats.isSymbolicLink() && path.isAbsolute(await fs.promises.readlink(src))) {
    throw new Error(`${src} is an absolute symlink, which would escape the temporary copy; use a relative symlink`);
  }
  return true;
}

function isCopiedProblemPath(src: string): boolean {
  const name = path.basename(src);
  return name !== 'node_modules' && name !== '.git';
}

async function symlinkAllAncestorNodeModules(tempRoot: string, problemDir: string): Promise<void> {
  let currentDir = path.resolve(problemDir);
  while (true) {
    const nodeModulesPath = path.join(currentDir, 'node_modules');
    if (fs.existsSync(nodeModulesPath)) {
      const targetSymlinkPath = path.join(tempRoot, toTempRelativePath(currentDir), 'node_modules');
      try {
        await fs.promises.symlink(
          nodeModulesPath,
          targetSymlinkPath,
          process.platform === 'win32' ? 'junction' : 'dir'
        );
      } catch {
        // Package resolution is best-effort; the isolation check still reports a clear spawn failure if imports break.
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
}

function toTempRelativePath(absolutePath: string): string {
  const { root } = path.parse(absolutePath);
  return path.relative(root, absolutePath);
}
