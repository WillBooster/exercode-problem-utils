import fs from 'node:fs/promises';
import path from 'node:path';

export const MODEL_ANSWERS_DIRNAME = 'model_answers';
export const FAILING_MODEL_ANSWERS_DIRNAME = 'model_answers.fails';

/**
 * Find model answer directories under `<problemDir>/model_answers/`.
 * Returns absolute paths sorted lexicographically.
 */
export async function findModelAnswerDirs(problemDir: string): Promise<string[]> {
  return findAnswerDirs(problemDir, MODEL_ANSWERS_DIRNAME);
}

/**
 * Find failing model answer directories under `<problemDir>/model_answers.fails/`.
 * Returns absolute paths sorted lexicographically.
 */
export async function findFailingModelAnswerDirs(problemDir: string): Promise<string[]> {
  return findAnswerDirs(problemDir, FAILING_MODEL_ANSWERS_DIRNAME);
}

async function findAnswerDirs(problemDir: string, dirname: string): Promise<string[]> {
  const modelAnswersDir = path.join(problemDir, dirname);
  let entries;
  try {
    entries = await fs.readdir(modelAnswersDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(modelAnswersDir, entry.name))
    .toSorted();
}
