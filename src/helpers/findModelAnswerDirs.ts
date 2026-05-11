import fs from 'node:fs/promises';
import path from 'node:path';

const MODEL_ANSWERS_DIRNAME = 'model_answers';

/**
 * Find model answer directories under `<problemDir>/model_answers/`.
 * Returns absolute paths sorted lexicographically.
 */
export async function findModelAnswerDirs(problemDir: string): Promise<string[]> {
  const modelAnswersDir = path.join(problemDir, MODEL_ANSWERS_DIRNAME);
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
