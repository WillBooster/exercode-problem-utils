import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const learningMaterialFixturesDir = join(import.meta.dirname, '..', 'fixtures', 'learningMaterial');

const tempDirectories = new Set<string>();

/** Copies a fixture subtree into a fresh temp directory so tests can mutate it independently. */
export async function copyFixtureToTempDir(fixtureRelativePath: string, targetName: string): Promise<string> {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'learning-material-'));
  tempDirectories.add(tempDirectory);
  const targetPath = join(tempDirectory, targetName);
  await cp(join(learningMaterialFixturesDir, fixtureRelativePath), targetPath, { recursive: true });
  return targetPath;
}

export async function createTempDir(): Promise<string> {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'learning-material-'));
  tempDirectories.add(tempDirectory);
  return tempDirectory;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all([...tempDirectories].map((directory) => rm(directory, { force: true, recursive: true })));
  tempDirectories.clear();
}
