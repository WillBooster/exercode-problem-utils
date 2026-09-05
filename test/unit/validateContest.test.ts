import { afterEach, describe, expect, test } from 'vitest';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateContestFile } from '../../src/learningMaterial/validateContest.js';
import { cleanupTempDirs, createTempDir, learningMaterialFixturesDir } from './learningMaterialTestHelpers.js';

const problemsDir = join(learningMaterialFixturesDir, 'problems');
const validContestPath = join(learningMaterialFixturesDir, 'contests', 'sample_contest.contest.yaml');

describe('validateContestFile', () => {
  afterEach(cleanupTempDirs);

  test('accepts the valid contest fixture', async () => {
    const result = await validateContestFile(validContestPath, { problemsDirectoryPath: problemsDir });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('rejects a missing contest file', async () => {
    const result = await validateContestFile(join(learningMaterialFixturesDir, 'contests', 'missing.contest.yaml'));
    expect(result.errors).toEqual([expect.stringContaining('contest file not found')]);
  });

  test('rejects a symbolic link to a contest file', async () => {
    const tempDir = await createTempDir();
    const contestPath = join(tempDir, 'linked.contest.yaml');
    await symlink(validContestPath, contestPath);
    const result = await validateContestFile(contestPath);
    expect(result.errors).toEqual([expect.stringContaining('contest file is a symbolic link')]);
  });

  test('accepts adminEmails and rejects a malformed address', async () => {
    const contestPath = await copyContestFixture(
      'sample_contest.contest.yaml',
      (content) => `${content}adminEmails:\n  - admin@example.com\n`
    );
    const result = await validateContestFile(contestPath, { problemsDirectoryPath: problemsDir });
    expect(result.errors).toEqual([]);
    const malformedPath = await copyContestFixture(
      'sample_contest.contest.yaml',
      (content) => `${content}adminEmails:\n  - not-an-email\n`
    );
    const malformedResult = await validateContestFile(malformedPath);
    expect(malformedResult.errors).toEqual([expect.stringContaining('adminEmails')]);
  });

  test('rejects a file name without the .contest.yaml suffix', async () => {
    const contestPath = await copyContestFixture('sample_contest.yaml');
    const result = await validateContestFile(contestPath);
    expect(result.errors).toEqual([expect.stringContaining('must end with .contest.yaml')]);
  });

  test('rejects a division whose openedAt is not earlier than closedAt', async () => {
    const contestPath = await copyContestFixture('sample_contest.contest.yaml', (content) =>
      content.replace("closedAt: '2026-01-01T12:00:00+09:00'", "closedAt: '2026-01-01T10:00:00+09:00'")
    );
    const result = await validateContestFile(contestPath);
    expect(result.errors).toEqual([expect.stringContaining('openedAt must be earlier than closedAt')]);
  });

  test('rejects duplicate division IDs', async () => {
    const contestPath = await copyContestFixture('sample_contest.contest.yaml', (content) =>
      content.replace('id: makeup', 'id: main')
    );
    const result = await validateContestFile(contestPath);
    expect(result.errors).toEqual([expect.stringContaining('duplicate division IDs: main')]);
  });

  test('rejects duplicate problem IDs', async () => {
    const contestPath = await copyContestFixture('sample_contest.contest.yaml', (content) =>
      content.replace('id: arithmetic_subtraction', 'id: a_plus_b')
    );
    const result = await validateContestFile(contestPath);
    expect(result.errors).toEqual([expect.stringContaining('duplicate problem IDs: a_plus_b')]);
  });

  test('rejects an unknown key', async () => {
    const contestPath = await copyContestFixture(
      'sample_contest.contest.yaml',
      (content) => `${content}unknownKey: 1\n`
    );
    const result = await validateContestFile(contestPath);
    expect(result.errors).toEqual([expect.stringContaining('unknownKey')]);
  });

  test('rejects a negative score', async () => {
    const contestPath = await copyContestFixture('sample_contest.contest.yaml', (content) =>
      content.replace('score: 100', 'score: -1')
    );
    const result = await validateContestFile(contestPath);
    expect(result.errors).toEqual([expect.stringContaining('problems.0.score')]);
  });

  test('rejects a problem ID that does not resolve to a problem directory', async () => {
    const contestPath = await copyContestFixture('sample_contest.contest.yaml', (content) =>
      content.replace('id: a_plus_b', 'id: missing_problem')
    );
    const result = await validateContestFile(contestPath, { problemsDirectoryPath: problemsDir });
    expect(result.errors).toEqual([
      expect.stringContaining('problem "missing_problem" is referenced but does not exist'),
    ]);
  });

  test('rejects a contest without divisions', async () => {
    const contestPath = await copyContestFixture('sample_contest.contest.yaml', (content) =>
      content.replace(/divisions:[\s\S]*?problems:/, 'divisions: []\nproblems:')
    );
    const result = await validateContestFile(contestPath);
    expect(result.errors).toEqual([expect.stringContaining('divisions')]);
  });
});

/** Copies the valid contest fixture into a temp directory, optionally mutating its YAML text. */
async function copyContestFixture(
  targetFileName: string,
  mutate: (content: string) => string = (content) => content
): Promise<string> {
  const tempDir = await createTempDir();
  const contestPath = join(tempDir, targetFileName);
  await writeFile(contestPath, mutate(await readFile(validContestPath, 'utf8')));
  return contestPath;
}
